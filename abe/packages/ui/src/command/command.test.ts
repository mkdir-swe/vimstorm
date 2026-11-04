import { describe, expect, test } from 'bun:test';
import { pendingRunData } from '@abe/core';
import { HELP, helpAnswer, IMPROVE_HELP, STATUS } from '@abe/testing';
import { endRow } from '../board/card-actions';
import { commandMode, matchScore, PICK_ROWS, threadLines } from './command';
import { keyHelp } from './keys';
import { type Node } from '../runtime/components';
import {
  type Answer,
  type Command,
  type Input,
  type MenuRow,
  mountLayer,
  type Word,
} from '../runtime/runtime';

const FACTORY_COMMANDS: Command[] = [
  { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
  { kind: 'open', screen: 'status' },
];
const FACTORY: Word = { word: 'factory', summary: 'the Factory view', commands: FACTORY_COMMANDS };

/** A word that asks first (`:board-tab mine|team|sessions`, #87). */
const TAB: Word = {
  word: 'board-tab',
  summary: "a Board's tab",
  ask: [
    {
      name: 'tab',
      kind: 'positional',
      type: 'enum',
      values: ['mine', 'team', 'sessions'],
      required: true,
      repeats: false,
      summary: 'which tab',
    },
  ],
  commands: ([tab = '']) => [{ kind: 'open', screen: 'factory', params: { tab } }],
};

/** A word that starts with a command's name (`:improve-retro`, #295). */
const RETRO: Word = {
  word: 'improve-retro',
  summary: 'an Improve retro chat',
  commands: [{ kind: 'open', screen: 'factory', params: { retro: 'me' } }],
};

const key = (k: string): Input => ({ kind: 'key', key: k });
const typed = (text: string): Input[] => Array.from(text, (ch) => key(ch === ' ' ? '<Space>' : ch));

/** Command mode with the fixture table: each input's commands, the tree after the last. */
const drive = (words: readonly Word[] = [FACTORY]) => {
  const layer = mountLayer(commandMode(words));
  const all: Command[][] = [];

  return {
    send: (...inputs: Input[]) => {
      let last: Command[] = [];

      for (const input of inputs) {
        last = layer.send(input);
        all.push(last);
      }

      return last;
    },
    get tree(): Node | undefined {
      return layer.tree;
    },
    all,
  };
};

/** Command mode open on the fixture table. */
const opened = (words?: readonly Word[]) => {
  const d = drive(words);

  d.send(key(':'), helpAnswer());

  return d;
};

const props = (tree: Node | undefined) => {
  if (tree === undefined) throw new Error('no layer is up');

  return tree.props;
};
const rowIds = (tree: Node | undefined): string[] => {
  const p = props(tree);

  return 'rows' in p ? p.rows.flatMap((r) => (r.id === undefined ? [] : [r.id])) : [];
};

const answer = (id: string, reply: Answer['reply'], text?: string): Answer =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a status reply, or a refusal any command may give
  ({ kind: 'result', id, command: 'status', reply, text }) as Answer;

describe('Command mode', () => {
  test("`:` opens at once on Anywhere's rows, the table read from abe help meanwhile", () => {
    const d = drive();

    expect(d.tree).toBeUndefined();
    expect(d.send(key(':'))).toEqual([
      { kind: 'shell', effect: { kind: 'status', text: '' } },
      { kind: 'run', id: 'help', argv: ['help'] },
    ]);
    expect(d.tree).toMatchObject({
      kind: 'PickLayer',
      props: { filter: '', placeholder: 'Ask anything, or a command', selected: 'anywhere:search' },
    });
    expect(rowIds(d.tree)).toEqual([
      'anywhere:search',
      'anywhere:settings',
      'anywhere:recent',
      'anywhere:workflows',
      'anywhere:keys',
    ]);
    d.send(helpAnswer(IMPROVE_HELP));
    expect(props(d.tree)).not.toHaveProperty('state');
    expect(rowIds(d.tree)).toContain('anywhere:improve');
  });

  test("More, only once typed: the screens' words, the table's commands but a session's or the client's, your own", () => {
    const d = opened();

    expect(rowIds(d.tree).some((id) => id.startsWith('command:'))).toBe(false);
    d.send(...typed('card'));
    // `card`: one word, its best match first, then the Ask, then the other matches under More
    expect(rowIds(d.tree)).toEqual([
      'command:card list',
      'here:ask',
      'command:card show',
      'command:card move',
      'personal:mine',
    ]);
    const p = props(d.tree);
    const row = (id: string) => ('rows' in p ? p.rows.find((r) => r.id === id) : undefined);

    expect(row('command:card show')).toEqual({
      id: 'command:card show',
      text: 'card show',
      dim: 'one card in full',
      note: '<card>',
      section: 'More',
    });
    expect(row('command:card move')).toMatchObject({ note: '<card> --column Doing|Done' });
    d.send(key('<C-u>'), ...typed('s'));
    expect(rowIds(d.tree)).not.toContain('command:factory decide');
    expect(rowIds(d.tree)).not.toContain('command:watch');
  });

  test('the `:` line is a command line: Home / End its caret, the row stays (#334)', () => {
    const d = opened();

    d.send(...typed('card s'), key('<Down>'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:ask' });
    d.send(key('<Home>'));
    expect(props(d.tree)).toMatchObject({ filter: 'card s', selected: 'here:ask' });
    d.send(...typed('x'), key('<End>'), ...typed('y'));
    expect(props(d.tree)).toMatchObject({ filter: 'xcard sy' });
  });

  test('every letter types on the `:` line, k l ö ä too; ↑ ↓ ⌃N ⌃P Tab ⇧Tab move (#346)', () => {
    const d = opened();

    d.send(...typed('look'));
    expect(props(d.tree)).toMatchObject({ filter: 'look' });
    d.send(key('<C-u>'), ...typed('card lä'));
    expect(props(d.tree)).toMatchObject({ filter: 'card lä' });
    d.send(key('<C-u>'), ...typed('card s'));
    expect(props(d.tree)).toMatchObject({ filter: 'card s', selected: 'command:card show' });
    expect(rowIds(d.tree)).toEqual(['command:card show', 'here:ask', 'command:card list']);
    d.send(key('<Down>'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:ask' });
    d.send(key('<C-n>'));
    expect(props(d.tree)).toMatchObject({ selected: 'command:card list' });
    d.send(key('<C-p>'), key('<S-Tab>'));
    expect(props(d.tree)).toMatchObject({ selected: 'command:card show' });
    d.send(key('<Tab>'), key('<Up>'));
    expect(props(d.tree)).toMatchObject({ filter: 'card s', selected: 'command:card show' });
    d.send(key('<BS>'), key('<BS>'));
    expect(props(d.tree)).toMatchObject({ filter: 'card' });
    d.send(key('<C-u>'), { kind: 'text', text: 'stat' });
    expect(rowIds(d.tree)).toEqual(['command:status', 'here:ask']);
    d.send(...typed('zz'));
    expect(rowIds(d.tree)).toEqual(['here:ask']);
  });

  test('the filter is a macOS field: ← → ⌥← ⌘← move its caret, ⌫ ⌥⌫ edit at it (#314)', () => {
    const d = opened();

    d.send(...typed('card sow'), key('<Left>'), key('<Left>'), key('h'));
    expect(props(d.tree)).toMatchObject({ filter: 'card show', caret: 7 });
    expect(rowIds(d.tree)[0]).toBe('command:card show');
    // ↑ ↓ still move the cursor, the caret stays
    d.send(key('<Down>'));
    expect(props(d.tree)).toMatchObject({ filter: 'card show', caret: 7 });
    d.send(key('<M-Left>'), key('<M-BS>'));
    expect(props(d.tree)).toMatchObject({ filter: 'show', caret: 0 });
    d.send(key('<D-Right>'));
    expect(props(d.tree)).toMatchObject({ filter: 'show' });
    expect(props(d.tree)).not.toHaveProperty('caret');
    d.send(key('<D-Left>'), { kind: 'text', text: 'card ' }, key('<Del>'));
    expect(props(d.tree)).toMatchObject({ filter: 'card how', caret: 5 });
  });

  test.each<[string, string, string, number | undefined]>([
    ['the whole name', 'card move', 'Card Move ', 0],
    ['a prefix of the name', 'card move', 'card m', 1],
    ['inside the name', 'card move', 'move', 2],
    ['its letters in order', 'card move', 'crd mve', 3],
    ['the summary', 'card move', 'column', 4],
    ['nothing', 'card move', 'xyz', undefined],
    ['an empty filter', 'card move', '  ', 0],
  ])('a filter matches %s', (_, name, filter, score) => {
    expect(matchScore(name, 'move a card to a column', filter)).toBe(score);
  });

  test('the rows scroll with the cursor, a window at a time', () => {
    const many = {
      ...HELP,
      commands: Array.from({ length: 30 }, (_, i) => ({
        ...(HELP.commands[0] ?? STATUS_ROW),
        noun: `n${String(i).padStart(2, '0')}`,
      })),
    };
    const d = drive();

    d.send(key(':'), helpAnswer(many), ...typed('n'));
    expect(rowIds(d.tree)).toHaveLength(PICK_ROWS);
    d.send(...Array.from({ length: 15 }, () => key('<Down>')));
    const ids = rowIds(d.tree);

    // the 16th row is where the cursor went, the window's last
    expect(ids).toHaveLength(PICK_ROWS);
    expect(props(d.tree)).toMatchObject({ selected: ids.at(-1) });
    expect(ids.at(-1)).toMatch(/^command:n1/);
  });

  test('a pick holding more rows than it shows says where its window is (#261)', () => {
    const many = {
      ...HELP,
      commands: Array.from({ length: 30 }, (_, i) => ({
        ...(HELP.commands[0] ?? STATUS_ROW),
        noun: `n${String(i).padStart(2, '0')}`,
      })),
    };
    const d = drive();

    d.send(key(':'), helpAnswer(many), ...typed('n'));
    // the 30 commands, the Ask, Settings and Recent projects (their names hold an n)
    expect(props(d.tree)).toMatchObject({ scroll: { top: 0, total: 33 } });
    d.send(...Array.from({ length: 15 }, () => key('<Down>')));
    expect(props(d.tree)).toMatchObject({ scroll: { top: 15 - PICK_ROWS + 1, total: 33 } });
    // filtered down to what fits: no scroll
    d.send(...typed('n0'));
    expect(rowIds(d.tree).length).toBeLessThanOrEqual(PICK_ROWS);
    expect(props(d.tree)).not.toHaveProperty('scroll');
  });

  test('`??` (every key) scrolls and says so; the rows past the window are reached (#261)', () => {
    const d = drive();

    const all = keyHelp('every').rows.length;

    expect(all).toBeGreaterThan(PICK_ROWS);
    d.send(key('?'), key('?'));
    expect(props(d.tree)).toMatchObject({ scroll: { top: 0, total: all } });
    d.send(...Array.from({ length: Math.ceil(all / 10) }, () => key('<PageDown>')));
    expect(props(d.tree)).toMatchObject({ scroll: { top: all - PICK_ROWS, total: all } });
    // Home / End the first and the last key (#334)
    d.send(key('<Home>'));
    expect(props(d.tree)).toMatchObject({ scroll: { top: 0, total: all } });
    d.send(key('<End>'));
    expect(props(d.tree)).toMatchObject({ scroll: { top: all - PICK_ROWS, total: all } });
  });

  test('⏎ asks a required argument in a PromptLayer, then runs the command through serve', () => {
    const d = opened();

    d.send(...typed('card sh'), key('<CR>'));
    expect(d.tree).toEqual({
      kind: 'PromptLayer',
      id: 'command-arg',
      props: { title: 'abe card show <card>', text: '', hint: 'the card' },
    });
    // every letter types into a field, `k l ö ä` too
    d.send(...typed('ö1l'), key('<BS>'), key('<BS>'), key('<BS>'), ...typed('12'));
    expect(props(d.tree)).toMatchObject({ text: '12' });
    expect(d.send(key('<CR>'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['card', 'show', '12'] },
    ]);
    expect(d.tree).toBeUndefined();
  });

  test("a prompt's field takes the caret's keys: ← ⌘← ⌥→ ⌫ ⌘⌫ (#314)", () => {
    const d = opened();

    d.send(...typed('card sh'), key('<CR>'), ...typed('124'), key('<Left>'), key('<BS>'));
    expect(props(d.tree)).toMatchObject({ text: '14', caret: 1 });
    d.send(key('<D-Left>'), key('9'), key('<M-Right>'));
    expect(props(d.tree)).toMatchObject({ text: '914' });
    expect(props(d.tree)).not.toHaveProperty('caret');
    d.send(key('<Left>'), key('<D-BS>'));
    expect(props(d.tree)).toMatchObject({ text: '4', caret: 0 });
    expect(d.send(key('<CR>'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['card', 'show', '4'] },
    ]);
  });

  test('an argument with values is a pick of them; flags go as --name value', () => {
    const d = opened();

    d.send(...typed('card mo'), key('<CR>'), ...typed('7'), key('<CR>'));
    expect(d.tree).toMatchObject({
      kind: 'PickLayer',
      props: { title: 'abe card move --column Doing|Done', selected: 'value:Doing' },
    });
    expect(rowIds(d.tree)).toEqual(['value:Doing', 'value:Done']);
    // a pick of values is a menu: ↓ moves there
    expect(d.send(key('<Down>'), key('<CR>'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['card', 'move', '7', '--column', 'Done'] },
    ]);
  });

  test('an empty answer is refused in the prompt; a click on a row chooses it', () => {
    const d = opened();

    d.send(...typed('card'), { kind: 'click', id: 'command:card show' });
    d.send(key('<CR>'));
    expect(props(d.tree)).toMatchObject({ text: '', error: 'card is needed' });
    d.send(key('4'));
    expect(props(d.tree)).not.toHaveProperty('error');
  });

  test('Esc closes the top layer first', () => {
    const d = opened();

    d.send(...typed('card mo'), key('<CR>'), ...typed('7'), key('<CR>'));
    expect(d.tree?.kind).toBe('PickLayer');
    d.send(key('<Esc>'));
    expect(d.tree).toMatchObject({ kind: 'PromptLayer', props: { text: '7' } });
    d.send(key('<Esc>'));
    expect(d.tree).toMatchObject({ kind: 'PickLayer', props: { filter: 'card mo' } });
    d.send(key('<Esc>'));
    expect(d.tree).toBeUndefined();
    // closed, a key is no one's
    expect(d.send(key('<CR>'))).toEqual([]);
  });

  test('a risky command asks first: No is the default, its letter runs it', () => {
    const d = opened();

    d.send(...typed('session st'), key('<CR>'), ...typed('4-ab'), key('<CR>'));
    expect(d.tree).toEqual({
      kind: 'ConfirmLayer',
      id: 'command-confirm',
      props: {
        question: 'Run abe session stop 4-ab?',
        details: ["stop a session's claude"],
        risky: { label: 'Yes, run it', letter: 'y' },
        no: 'No',
        focus: 'no',
      },
    });
    // ⏎ is No: back to the argument
    expect(d.send(key('<CR>'))).toEqual([]);
    expect(d.tree?.kind).toBe('PromptLayer');
    d.send(key('<CR>'), key('k'));
    expect(props(d.tree)).toMatchObject({ focus: 'risky' });
    d.send(key('ä'));
    expect(props(d.tree)).toMatchObject({ focus: 'no' });
    expect(d.send(key('y'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['session', 'stop', '4-ab'] },
    ]);
    expect(d.tree).toBeUndefined();
  });

  test("a success's one line goes to the status line, a refusal to a balloon with its code", () => {
    const d = opened();

    d.send(...typed('status'), key('<CR>'));
    expect(d.all.at(-1)).toEqual([{ kind: 'run', id: 'run:1', argv: ['status'] }]);
    expect(
      d.send(answer('run:1', { ok: true, data: STATUS }, '\nabe serve 2.0.0, pid 4242\n')),
    ).toEqual([
      { kind: 'shell', effect: { kind: 'status', text: 'abe status: abe serve 2.0.0, pid 4242' } },
    ]);
    d.send(key(':'), helpAnswer(), ...typed('card sh'), key('<CR>'), ...typed('99'), key('<CR>'));
    expect(
      d.send(answer('run:2', { ok: false, error: { code: 'no-card', message: 'no card 99' } })),
    ).toEqual([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'error', text: 'no card 99 (no-card)' } },
    ]);
    // an answer that is no run's is nobody's
    expect(d.send(answer('run:7', { ok: true, data: STATUS }))).toEqual([]);
  });

  test("a screen's word does what it says and closes; your own command runs its argv", () => {
    const d = opened();

    d.send(...typed('factory'));
    expect(d.send(key('<CR>'))).toEqual(FACTORY_COMMANDS);
    expect(d.tree).toBeUndefined();
    d.send(key(':'), helpAnswer(), ...typed('mine'), key('<CR>'));
    expect(d.all.at(-1)).toEqual([{ kind: 'run', id: 'run:1', argv: ['card', 'list', '--mine'] }]);
  });

  test('a word that asks picks its arguments first, then does what it says with them', () => {
    const d = opened([FACTORY, TAB]);

    d.send(...typed('board-tab'), key('<CR>'));
    const pick = d.tree;

    expect(pick?.kind).toBe('PickLayer');
    expect(pick?.kind === 'PickLayer' ? pick.props.title : '').toBe(
      ':board-tab mine|team|sessions',
    );
    expect(pick?.kind === 'PickLayer' ? pick.props.rows.map((r) => r.text) : []).toEqual([
      'mine',
      'team',
      'sessions',
    ]);
    expect(d.send(key('<Down>'), key('<CR>'))).toEqual([
      { kind: 'open', screen: 'factory', params: { tab: 'team' } },
    ]);
    expect(d.tree).toBeUndefined();
  });

  test("a command's exact name wins over a word that starts with it (#295)", () => {
    const d = drive([FACTORY, RETRO]);

    d.send(key(':'), helpAnswer(IMPROVE_HELP), ...typed('improve'));
    expect(rowIds(d.tree)[0]).toBe('command:improve');
    expect(rowIds(d.tree)).toContain('word:improve-retro');
    expect(props(d.tree)).toMatchObject({ selected: 'command:improve' });
  });

  test('a run abe refuses before any command runs (its usage) is a balloon too', () => {
    const d = opened();

    d.send(...typed('card sh'), key('<CR>'), ...typed('--x'), key('<CR>'));
    expect(
      d.send({
        kind: 'result',
        id: 'run:1',
        command: null,
        reply: { ok: false, error: { code: 'usage', message: 'unknown flag --x' } },
      }),
    ).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'balloon', tone: 'error', text: 'unknown flag --x (usage)' },
      },
    ]);
  });

  test('your own command takes the risk and the place of the command it runs', () => {
    const d = drive();

    d.send(
      key(':'),
      helpAnswer({
        ...HELP,
        personal: [
          { name: 'halt', argv: ['session', 'stop', '4-ab'], summary: null },
          { name: 'decide', argv: ['factory', 'decide'], summary: null },
          { name: 'tail', argv: ['watch'], summary: null },
        ],
      }),
    );
    d.send(...typed('a'));
    expect(rowIds(d.tree).filter((id) => id.startsWith('personal:'))).toEqual(['personal:halt']);
    d.send(key('<C-u>'), ...typed('halt'), key('<CR>'));
    expect(d.tree?.kind).toBe('ConfirmLayer');
    expect(d.send(key('y'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['session', 'stop', '4-ab'] },
    ]);
  });

  test('the keyboard going elsewhere closes every layer', () => {
    const d = opened();

    d.send(...typed('card sh'), key('<CR>'), key('1'));
    expect(d.tree?.kind).toBe('PromptLayer');
    expect(d.send({ kind: 'blur' })).toEqual([]);
    expect(d.tree).toBeUndefined();
    d.send(key(':'));
    expect(props(d.tree)).toMatchObject({ filter: '' });
  });

  test("`::` is Neovim's own command line", () => {
    const d = opened();

    expect(d.send(key(':'))).toEqual([{ kind: 'shell', effect: { kind: 'cmdline' } }]);
    expect(d.tree).toBeUndefined();
    // a `:` after other text types
    d.send(key(':'), helpAnswer(), key('a'), key(':'));
    expect(props(d.tree)).toMatchObject({ filter: 'a:' });
  });

  test("a screen's confirm (Stop…): its question and yes; No the default, `y` runs it", () => {
    const d = drive();
    const ask: Input = {
      kind: 'confirm',
      argv: ['session', 'stop', '4-a1b2'],
      question: "Stop #4's session?",
      details: ['Its worktree stays.'],
      yes: 'Stop',
    };

    d.send(ask);
    expect(d.tree).toEqual({
      kind: 'ConfirmLayer',
      id: 'command-confirm',
      props: {
        question: "Stop #4's session?",
        details: ['Its worktree stays.'],
        risky: { label: 'Stop', letter: 'y' },
        no: 'No',
        focus: 'no',
      },
    });
    // ⏎ on No: nothing runs
    expect(d.send(key('<CR>'))).toEqual([]);
    expect(d.tree).toBeUndefined();
    d.send(ask);
    expect(d.send(key('y'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['session', 'stop', '4-a1b2'] },
    ]);
    expect(d.tree).toBeUndefined();
  });

  test('a help that fails says why in the pick', () => {
    const d = drive();

    d.send(key(':'), {
      kind: 'result',
      id: 'help',
      command: 'help',
      reply: { ok: false, error: { code: 'failed', message: 'no table' } },
    });
    d.send(...typed('card'));
    expect(props(d.tree)).toMatchObject({
      rows: [
        { id: 'here:ask' },
        { id: 'more:failed', text: 'Commands', reason: 'no table', section: 'More' },
      ],
    });
  });
});

const STATUS_ROW = {
  noun: 'status',
  verb: null,
  usage: 'abe status [--json]',
  summary: 'status',
  inSession: true,
  only: null,
  risky: false,
  args: [],
};

describe("a screen's menu: a risky row's letter, a row handed back after asking", () => {
  const MENU: Command = {
    kind: 'menu',
    id: 'thing:1',
    title: 'thing 1',
    rows: [
      { id: 'open', text: 'Open', does: { kind: 'back' } },
      {
        id: 'port',
        text: 'Port…',
        does: {
          kind: 'back',
          ask: [
            {
              name: 'port',
              kind: 'positional',
              type: 'number',
              required: true,
              repeats: false,
              summary: 'its port',
              title: 'Port on it',
            },
          ],
        },
      },
      {
        id: 'drop',
        text: 'Drop…',
        letter: 'd',
        risky: true,
        does: { kind: 'back', confirm: { question: 'Drop thing 1?', yes: 'Drop' } },
      },
    ],
  };

  test('the letter as the first key asks, y hands the row back; after a filter it types', () => {
    const d = drive();

    d.send(MENU);
    expect(props(d.tree)).toMatchObject({
      rows: [{ id: 'open' }, { id: 'port' }, { id: 'drop', risky: true }],
    });
    d.send(key('d'));
    expect(d.tree?.kind).toBe('ConfirmLayer');
    expect(props(d.tree)).toMatchObject({ question: 'Drop thing 1?', risky: { label: 'Drop' } });
    expect(d.send(key('y'))).toEqual([{ kind: 'choice', menu: 'thing:1', row: 'drop' }]);
    expect(d.tree).toBeUndefined();
    d.send(MENU, key('o'), key('d'));
    expect(props(d.tree)).toMatchObject({ filter: 'od', rows: [] });
  });

  test('a row that asks: its field titled, the value handed back with the row', () => {
    const d = drive();

    d.send(MENU, key('p'), key('<CR>'));
    expect(props(d.tree)).toMatchObject({ title: 'Port on it' });
    expect(d.send(...typed('3000'), key('<CR>'))).toEqual([
      { kind: 'choice', menu: 'thing:1', row: 'port', values: ['3000'] },
    ]);
  });

  test('a menu with its row chosen: the field at once, no list; Esc closes it', () => {
    const d = drive();

    d.send({ ...MENU, chosen: 'port' });
    expect(d.tree?.kind).toBe('PromptLayer');
    expect(props(d.tree)).toMatchObject({ title: 'Port on it' });
    expect(d.send(...typed('3000'), key('<CR>'))).toEqual([
      { kind: 'choice', menu: 'thing:1', row: 'port', values: ['3000'] },
    ]);
    d.send({ ...MENU, chosen: 'port' }, key('<Esc>'));
    expect(d.tree).toBeUndefined();
  });
});

describe('End run… on a queued run (#234): asked how and why, then run; never silent', () => {
  const run = pendingRunData({
    session: '4-ab12',
    card: 4,
    title: 'Gift cards',
    repo: 'mkdir-swe/demo-shop',
    worktree: '/workspace/repo',
    at: '2026-10-25T10:00:00.000Z',
    queued: true,
  });
  const MENU: Command = { kind: 'menu', id: 'card:4', title: '#4', rows: [endRow(4, run)] };

  test('Abandoned and a why run `factory end`; its answer goes on the status line, a refusal in a balloon', () => {
    const d = drive();

    // End run… spends: the menu rests on no row until a move picks it (#313)
    d.send(MENU, key('<Down>'), key('<CR>'));
    expect(props(d.tree)).toMatchObject({ title: 'End the run as' });
    d.send(...typed('Abandoned'), key('<CR>'));
    expect(props(d.tree)).toMatchObject({ title: 'Why (kept with the run, on the pull request)' });
    expect(d.send(...typed('not now'), key('<CR>'))).toEqual([
      {
        kind: 'run',
        id: 'run:1',
        argv: ['factory', 'end', '4', '--as', 'abandoned', '--reason', 'not now'],
      },
    ]);
    expect(
      d.send(answer('run:1', { ok: false, error: { code: 'box-asleep', message: 'it sleeps' } })),
    ).toEqual([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'error', text: 'it sleeps (box-asleep)' } },
    ]);
    // ended: its first line on the status line
    d.send(
      MENU,
      key('<Down>'),
      key('<CR>'),
      ...typed('Abandoned'),
      key('<CR>'),
      ...typed('not now'),
      key('<CR>'),
    );
    expect(
      d.send(
        answer(
          'run:2',
          { ok: true, data: STATUS },
          'AB#4 ended: abandoned · not now\n  session   4-ab12 taken out of the queue for demo-4\n',
        ),
      ),
    ).toEqual([
      { kind: 'shell', effect: { kind: 'status', text: 'AB#4 ended: abandoned · not now' } },
    ]);
  });
});

describe('End run… starts on the neutral way (#320): Done is never preselected', () => {
  const run = (reason: string) => ({
    ...pendingRunData({
      session: '4-ab12',
      card: 4,
      title: 'Prices without the euro sign',
      repo: 'mkdir-swe/demo-shop',
      worktree: '/workspace/repo',
      at: '2026-10-25T10:00:00.000Z',
      queued: false,
    }),
    state: 'needs-you' as const,
    reason,
  });
  const ended = (reason: string) => {
    const d = drive();
    const menu: Command = {
      kind: 'menu',
      id: 'card:4',
      title: '#4',
      rows: [endRow(4, run(reason))],
    };

    // End run… spends: the menu rests on no row until a move picks it (#313)
    d.send(menu, key('<Down>'), key('<CR>'));
    const picked = props(d.tree);

    d.send(key('<CR>'));

    return { picked, argv: d.send(...typed('why'), key('<CR>')) };
  };

  test('a bug that does not reproduce: Not reproduced selected, ⏎ ends it so', () => {
    const { picked, argv } = ended('not reproduced: the code formats every price with EUR');

    expect(picked).toMatchObject({ title: 'End the run as', selected: 'value:not-reproduced' });
    expect(argv).toEqual([
      {
        kind: 'run',
        id: 'run:1',
        argv: ['factory', 'end', '4', '--as', 'not-reproduced', '--reason', 'why'],
      },
    ]);
  });

  test('anything else: Abandoned selected', () => {
    const { picked, argv } = ended('the deploy to test failed');

    expect(picked).toMatchObject({ selected: 'value:abandoned' });
    expect(argv).toMatchObject([
      { argv: ['factory', 'end', '4', '--as', 'abandoned', '--reason', 'why'] },
    ]);
  });
});

describe('what a run says, in words (#204)', () => {
  const STOP: Command = {
    kind: 'menu',
    id: 'chat:session',
    title: '#30',
    rows: [
      {
        id: 'stop',
        text: 'Stop…',
        does: {
          kind: 'run',
          argv: ['session', 'stop', '30-0401'],
          risky: true,
          confirm: {
            question: "Stop #30's session?",
            details: ['Its worktree and branch stay.'],
            yes: 'Stop',
          },
          done: "Stopped #30's session",
        },
      },
      { id: 'move', text: 'Move…', does: { kind: 'run', argv: ['card', 'move', '30', 'Active'] } },
    ],
  };
  const ok = (id: string, text: string) => answer(id, { ok: true, data: STATUS }, text);
  const status = (text: string): Command[] => [{ kind: 'shell', effect: { kind: 'status', text } }];
  const ISO = '2026-10-24T11:33:08.330Z';
  const local = (iso: string) => {
    const d = new Date(iso);

    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  test("a menu row's confirm asks its own question; done, its own words, never the CLI", () => {
    const d = drive();

    d.send(STOP, key('<Up>'), key('<CR>'));
    expect(props(d.tree)).toMatchObject({
      question: "Stop #30's session?",
      details: ['Its worktree and branch stay.'],
      risky: { label: 'Stop' },
    });
    expect(d.send(key('y'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['session', 'stop', '30-0401'] },
    ]);
    expect(d.send(ok('run:1', `30-0401  AB#30  ended since ${ISO}  card/30-x\n`))).toEqual(
      status("Stopped #30's session"),
    );
  });

  test("a screen's confirm says its done words too", () => {
    const d = drive();

    d.send({
      kind: 'confirm',
      argv: ['session', 'stop', '4-a1b2'],
      question: "Stop #4's session?",
      yes: 'Stop',
      done: "Stopped #4's session",
    });
    d.send(key('y'));
    expect(d.send(ok('run:1', `4-a1b2  AB#4  ended since ${ISO}\n`))).toEqual(
      status("Stopped #4's session"),
    );
  });

  test("a menu row with no words of its own: the CLI's answer as a sentence, no `abe …` echo", () => {
    const d = drive();

    d.send(STOP, key('<Down>'), key('<CR>'));
    expect(d.send(ok('run:1', 'moved AB#30 to Active\n'))).toEqual(status('Moved AB#30 to Active'));
  });

  test('a time in an answer is said in local time, not ISO', () => {
    const d = opened();

    d.send(...typed('status'), key('<CR>'));
    const [said] = d.send(ok('run:1', `abe serve up since ${ISO}\n`));

    expect(said).toMatchObject({ kind: 'shell', effect: { kind: 'status' } });
    const text = said?.kind === 'shell' && said.effect.kind === 'status' ? said.effect.text : '';

    expect(text).not.toContain('2026-10-24T');
    expect(text).toContain(local(ISO));
  });

  test("a typed command's answer of many lines: its rows in a list, Esc closes it", () => {
    const d = opened();

    d.send(...typed('status'), key('<CR>'));
    const said = d.send(
      ok(
        'run:1',
        `30-d616  AB#30  ended since ${ISO}  card/30-a\n31-0aa1  AB#31  working since ${ISO}  card/31-b\n`,
      ),
    );

    expect(said).toEqual([]);
    expect(d.tree).toMatchObject({ kind: 'PickLayer', props: { title: 'abe status' } });
    const p = props(d.tree);
    const rows = 'rows' in p ? p.rows.map((r) => ('text' in r ? r.text : '')) : [];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('AB#30');
    expect(rows[1]).toContain('AB#31');
    expect(rows.join(' ')).not.toContain('2026-10-24T');
    d.send(key('<Esc>'));
    expect(d.tree).toBeUndefined();
  });
});

describe('a dialog’s primary takes no ⏎ that came too soon (#285)', () => {
  const DIALOG: Command = {
    kind: 'dialog',
    id: 'dialog:20',
    lines: 0,
    dialog: {
      kind: 'CardDialog',
      props: {
        kicker: '',
        card: 20,
        state: 'New',
        title: 'Free shipping over 500 kr',
        meta: [],
        sections: [],
        scroll: 0,
        buttons: [{ id: 'dialog:primary', label: 'Launch agent', keys: '⏎', primary: true }],
      },
    },
  };
  const at = (ms: number): Input => ({
    kind: 'tick',
    at: new Date(Date.UTC(2026, 9, 25, 2, 0, 0, ms)).toISOString(),
  });
  const LAUNCHED: Command[] = [{ kind: 'choice', menu: 'dialog:20', row: 'primary' }];

  test('the ⏎ right after it opened does nothing (⏎ ⏎ on a card); one after a pause launches', () => {
    const d = drive();

    d.send(at(0), DIALOG);
    expect(d.send(at(120), key('<CR>'))).toEqual([]);
    expect(d.tree?.kind).toBe('CardDialog');
    expect(d.send(at(900), key('<CR>'))).toEqual(LAUNCHED);
    expect(d.tree).toBeUndefined();
  });

  test('a held ⏎ never launches: each repeat starts the wait again', () => {
    const d = drive();

    d.send(at(0), DIALOG);
    for (let ms = 450; ms < 3000; ms += 80) expect(d.send(at(ms), key('<CR>'))).toEqual([]);
    expect(d.tree?.kind).toBe('CardDialog');
    // let go, then a ⏎ of its own
    expect(d.send(at(3600), key('<CR>'))).toEqual(LAUNCHED);
  });

  test('a click on the primary is taken at once; Esc and ⌘⏎ are not held back', () => {
    const d = drive();

    d.send(at(0), DIALOG);
    expect(d.send(at(50), key('<D-CR>'))).toEqual([
      { kind: 'choice', menu: 'dialog:20', row: 'menu' },
    ]);
    d.send(at(60), DIALOG);
    expect(d.send(at(70), { kind: 'click', id: 'dialog:primary' })).toEqual(LAUNCHED);
    d.send(at(80), DIALOG);
    d.send(at(90), key('<Esc>'));
    expect(d.tree).toBeUndefined();
  });
});

describe("a card dialog's buttons take the keys: ← → Tab move, ⏎ presses the one they are on", () => {
  type Button = { id: string; label: string; primary?: boolean; reason?: string };
  const DRAFT: Button = { id: 'dialog:menu', label: 'Draft with the agent' };
  const MAKE: Button = { id: 'dialog:primary', label: 'Make card', primary: true };
  const SHEETS = { rows: [{ id: 'sheet:20/a', title: 'Checkout' }] };
  const open = (
    buttons: Button[],
    sheets?: typeof SHEETS,
  ): Extract<Command, { kind: 'dialog' }> => ({
    kind: 'dialog',
    id: 'dialog:20',
    lines: 0,
    dialog: {
      kind: 'CardDialog',
      props: {
        kicker: '',
        card: 20,
        state: 'New',
        title: 'Free shipping over 500 kr',
        meta: [],
        sections: [],
        scroll: 0,
        buttons,
        ...(sheets === undefined ? {} : { sheets }),
      },
    },
  });
  const MADE: Command[] = [{ kind: 'choice', menu: 'dialog:20', row: 'primary' }];
  const DRAFTED: Command[] = [{ kind: 'choice', menu: 'dialog:20', row: 'menu' }];

  test.each<[string, Button[], string[], string | undefined, Command[]]>([
    ['the keys on none: ⏎ is the primary', [DRAFT, MAKE], [], undefined, MADE],
    ['← to the one before it', [DRAFT, MAKE], ['<Left>'], 'dialog:menu', DRAFTED],
    ['k the same', [DRAFT, MAKE], ['k'], 'dialog:menu', DRAFTED],
    ['→ back', [DRAFT, MAKE], ['k', 'ä'], 'dialog:primary', MADE],
    ['→ past the last stays there', [DRAFT, MAKE], ['<Right>'], 'dialog:primary', MADE],
    ['Tab past the last wraps to the first', [DRAFT, MAKE], ['<Tab>'], 'dialog:menu', DRAFTED],
    ['⇧Tab back', [DRAFT, MAKE], ['<Tab>', '<S-Tab>'], 'dialog:primary', MADE],
    [
      'a grey one is passed over',
      [{ ...DRAFT, reason: 'nothing typed yet' }, MAKE],
      ['<Left>'],
      'dialog:primary',
      MADE,
    ],
  ])('%s', (_, buttons, keys, focus, pressed) => {
    const d = drive();

    d.send(open(buttons), ...keys.map(key));
    const p = props(d.tree);

    expect('focus' in p ? p.focus : undefined).toBe(focus);
    expect(d.send(key('<CR>'))).toEqual(pressed);
  });

  test('Tab past the last button goes into its Sheets; Tab there on to the first button', () => {
    const d = drive();

    d.send(open([DRAFT, MAKE], SHEETS), key('<Tab>'));
    expect(props(d.tree)).toMatchObject({ sheets: { focused: true, selected: 'sheet:20/a' } });
    d.send(key('<Tab>'));
    expect(props(d.tree)).toMatchObject({ focus: 'dialog:menu' });
    // ⇧Tab from the Sheets: the last one
    d.send(key('<S-Tab>'), key('<S-Tab>'));
    expect(props(d.tree)).toMatchObject({ focus: 'dialog:primary' });
  });

  test('⏎ on Close closes it', () => {
    const d = drive();

    d.send(open([{ id: 'dialog:close', label: 'Close' }]), key('<Tab>'));
    expect(d.send(key('<CR>'))).toEqual([]);
    expect(d.tree).toBeUndefined();
  });
});

describe('a card dialog scrolls within its page', () => {
  /** A story dialog of 8 source lines, as a screen hands it over. */
  const STORY: Extract<Input, { kind: 'dialog' }> = {
    kind: 'dialog',
    id: 'dialog:4',
    lines: 8,
    dialog: {
      kind: 'CardDialog',
      id: 'dialog:4',
      props: {
        kicker: 'User Story',
        card: 4,
        state: 'Active',
        title: 'Cart total includes shipping',
        meta: [],
        sections: [{ title: 'Description', markdown: 'a\nb\nc\nd\ne\nf' }],
        scroll: 0,
        buttons: [],
        heading: 'Story',
      },
    },
  };
  /** The page as the window drew it, `lines` to scroll. */
  const extent = (lines: number, id = 'dialog:4'): Input => ({ kind: 'extent', id, lines });
  const scroll = (d: ReturnType<typeof drive>) => {
    const p = props(d.tree);

    return 'scroll' in p ? p.scroll : undefined;
  };

  test.each<[string, Input[], number]>([
    ['ö ö ö l: two lines down', ['ö', 'ö', 'ö', 'l'].map(key), 2],
    ['G the end of its source', [key('G')], 8],
    ['gg the top', [key('G'), key('g'), key('g')], 0],
    ['End as G', [key('<End>')], 8],
    ['Home as gg', [key('G'), key('<Home>')], 0],
    ['the window’s extent: G its real end', [extent(3), key('G')], 3],
    ['at the end, ö stays', [extent(3), key('G'), key('ö'), key('ö')], 3],
    ['the first l moves at once', [extent(3), key('G'), key('ö'), key('l')], 2],
    [
      'another dialog’s extent is not this one’s',
      [extent(3), key('G'), key('l'), extent(1, 'dialog:9')],
      2,
    ],
    ['G before the extent is in follows it to the end', [key('G'), extent(40)], 40],
    [
      'not at the end: a new extent keeps the place',
      [key('G'), extent(40), key('l'), key('l'), extent(30)],
      30,
    ],
    ['a page that fits never counts as at its end', [extent(0), key('ö'), key('G'), extent(12)], 0],
    ['the same dialog opened again keeps the page measured', [extent(3), STORY, key('G')], 3],
  ])('%s', (_, inputs, want) => {
    const d = drive();

    d.send(STORY, ...inputs);
    expect(scroll(d)).toBe(want);
  });
});

describe('a menu never opens on a row that spends or deletes (#313, #278)', () => {
  const back = { kind: 'back' } as const;
  const menu = (rows: MenuRow[]): Input => ({ kind: 'menu', id: 'card:4', title: '#4', rows });
  const selected = (d: ReturnType<typeof drive>) => {
    const p = props(d.tree);

    return 'selected' in p ? p.selected : undefined;
  };
  const MOVE: MenuRow = {
    id: 'move',
    text: 'Move…',
    does: {
      kind: 'run',
      argv: ['card', 'move', '4'],
      ask: [
        {
          name: 'state',
          kind: 'positional',
          type: 'enum',
          values: ['Active', 'Closed'],
          required: true,
          repeats: false,
          summary: 'the state',
        },
      ],
    },
  };
  const ROWS: MenuRow[] = [
    { id: 'launch', text: 'Launch agent', costly: true, does: back },
    { id: 'worktree', text: 'Open worktree', reason: 'no worktree yet', does: back },
    { id: 'terminate', text: 'Terminate…', risky: true, does: back },
    {
      id: 'stop',
      text: 'Stop…',
      does: { kind: 'run', argv: ['session', 'stop', 's4'], risky: true },
    },
    {
      id: 'end',
      text: 'End…',
      does: { kind: 'back', confirm: { question: 'End it?', yes: 'End' } },
    },
    MOVE,
    { id: 'comment', text: 'Comment…', does: back },
  ];

  test('past rows that spend, delete or ask first, to the first that does neither', () => {
    const d = drive();

    d.send(menu(ROWS));
    expect(selected(d)).toBe('comment');
    // a held ⏎ never gets further than that row's own
    expect(d.send(key('<CR>'))).toEqual([{ kind: 'choice', menu: 'card:4', row: 'comment' }]);
  });

  test('a row that asks first, when none asks nothing; the costly rows stay in their place', () => {
    const d = drive();

    d.send(menu(ROWS.slice(0, 6)));
    expect(selected(d)).toBe('move');
    expect(rowIds(d.tree)[0]).toBe('launch');
    expect(d.send(key('<PageUp>'), key('<CR>'))).toEqual([
      { kind: 'choice', menu: 'card:4', row: 'launch' },
    ]);
  });

  test('typed, a costly row is chosen as typed; the filter erased, the safe row again', () => {
    const d = drive();

    d.send(menu(ROWS), ...typed('Lau'));
    expect(selected(d)).toBe('launch');
    d.send(key('<BS>'), key('<BS>'), key('<BS>'));
    expect(selected(d)).toBe('comment');
    // ⌫ on an empty filter moves nothing
    d.send(key('<BS>'));
    expect(selected(d)).toBe('comment');
    d.send(...typed('Lau'), key('<C-u>'));
    expect(selected(d)).toBe('comment');
  });

  test('Home / End the first and the last row a move can land on (#334), typed or not', () => {
    const d = drive();

    d.send(menu([...ROWS, { id: 'last', text: 'Last', reason: 'not here', does: back }]));
    d.send(key('<End>'));
    expect(selected(d)).toBe('comment');
    d.send(key('<Home>'));
    expect(selected(d)).toBe('launch');
    d.send(...typed('o'), key('<End>'));
    expect(selected(d)).toBe('comment');
  });

  test('only costly rows: none selected, ⏎ chooses nothing until a move picks one', () => {
    const d = drive();

    d.send(
      menu([
        { id: 'launch-local-sandbox', text: 'Launch in Local sandbox', costly: true, does: back },
        { id: 'launch-cloud', text: 'Launch on a box', costly: true, does: back },
      ]),
    );
    expect(selected(d)).toBeUndefined();
    expect(d.send(key('<CR>'))).toEqual([]);
    d.send(key('<Down>'));
    expect(selected(d)).toBe('launch-local-sandbox');
    expect(d.send(key('<CR>'))).toEqual([
      { kind: 'choice', menu: 'card:4', row: 'launch-local-sandbox' },
    ]);
  });
});

describe('threadLines (#98: the CommentBox’s lines, decided here, not in the shell)', () => {
  test('blank lines and leading quote marks dropped, the rest as written', () => {
    expect(threadLines('> *This was generated by AI.*\n\n## Notes\n\n> > nested\n  - a list')).toBe(
      '*This was generated by AI.*\n## Notes\nnested\n- a list',
    );
  });
});

describe('the `:` line starts from where it was opened (#346)', () => {
  const MENU: Command & { kind: 'menu' } = {
    kind: 'menu',
    id: 'card:1234',
    title: '#1234 Cart total includes shipping',
    rows: [
      { id: 'move', text: 'Move…', does: { kind: 'back' } },
      { id: 'launch', text: 'Launch agent', reason: 'already running', does: { kind: 'back' } },
    ],
  };
  const HERE: Input = {
    kind: 'here',
    serving: true,
    project: 'demo-shop',
    here: {
      keys: 'sessions',
      subject: {
        caption: '#1234 Cart total includes shipping',
        label: '#1234',
        ask: ['--card', '1234'],
        menu: MENU,
        tell: { session: '1234-ab12', whose: '#1234', dim: 'it is working', card: 1234 },
      },
    },
  };

  test('nothing typed: the Subject first under its caption, ⏎ its next step handed back', () => {
    const d = drive();

    d.send(HERE, key(':'), helpAnswer());
    const p = props(d.tree);

    expect(p).toMatchObject({ selected: 'subject:move' });
    expect('rows' in p ? p.rows.slice(0, 3) : []).toMatchObject([
      { id: 'subject:move', text: 'Move…', section: '#1234 Cart total includes shipping' },
      { id: 'subject:all', text: 'All #1234 actions…', note: '⌘⏎' },
      { id: 'anywhere:search', section: 'Anywhere' },
    ]);
    expect(d.send(key('<CR>'))).toEqual([{ kind: 'choice', menu: 'card:1234', row: 'move' }]);
  });

  test('a grey row first (Install Abe… in a worktree): none selected, ↓ the first that can run', () => {
    const d = drive();
    const install = {
      noun: 'install',
      verb: null,
      usage: 'abe install [--json]',
      summary: 'set up the repo',
      only: null,
      inSession: false,
      risky: false,
      args: [],
    };

    d.send(
      {
        kind: 'here',
        serving: true,
        project: 'demo-shop',
        checkout: { main: false, installed: false },
        here: { keys: 'view' },
      },
      key(':'),
      helpAnswer({ ...HELP, commands: [...HELP.commands, install] }),
      ...typed('install'),
    );
    const p = props(d.tree);

    expect('rows' in p ? p.rows.slice(0, 2) : []).toMatchObject([
      { id: 'here:install', reason: "only in the repo's main checkout" },
      { id: 'here:ask' },
    ]);
    expect(props(d.tree)).not.toHaveProperty('selected');
    d.send(key('<C-n>'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:ask' });
    d.send(key('<Up>'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:ask' });
  });

  test('All … actions…: the whole menu, its grey rows with their reason', () => {
    const d = drive();

    d.send(HERE, key(':'), helpAnswer(), ...typed('all'), key('<CR>'));
    expect(d.tree).toMatchObject({
      kind: 'PickLayer',
      id: 'action-menu',
      props: { rows: [{ id: 'move' }, { id: 'launch', reason: 'already running' }] },
    });
  });

  test('a sentence goes to the Abe chat with the Subject, its answer pins Chat on it', () => {
    const d = drive();

    d.send(HERE, key(':'), helpAnswer(), ...typed('why is it slow'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:ask' });
    expect(d.send(key('<CR>'))).toEqual([
      {
        kind: 'run',
        id: 'ask-run:1',
        argv: ['chat', 'why', 'is', 'it', 'slow', '(about #1234 Cart total includes shipping)'],
      },
    ]);
    expect(d.tree).toBeUndefined();
    expect(
      d.send({
        kind: 'result',
        id: 'ask-run:1',
        command: 'chat',
        reply: {
          ok: true,
          data: {
            repo: '/p',
            id: 'abe-1a2b',
            title: 'Abe · p',
            state: 'waiting',
            opened: 'running',
          },
        },
      }),
    ).toEqual([
      { kind: 'open', screen: 'chat', params: { session: 'abe-1a2b' }, slot: 'chat' },
      { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
    ]);
  });

  test("Tell #1234's session: the words typed into it, said on the status line", () => {
    const d = drive();

    d.send(HERE, key(':'), helpAnswer(), ...typed('also check vat'), key('<Down>'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:tell' });
    expect(d.send(key('<CR>'))).toEqual([
      { kind: 'run', id: 'run:1', argv: ['session', 'send', '1234-ab12', 'also', 'check', 'vat'] },
    ]);
    expect(d.send(answer('run:1', { ok: true, data: STATUS }))).toEqual([
      { kind: 'shell', effect: { kind: 'status', text: 'Told #1234’s session' } },
    ]);
  });

  test("`?` lists the keys of the surface it was pressed on: here the Sessions list's", () => {
    const d = drive();

    d.send(HERE, key('?'));
    expect(d.tree).toMatchObject({ props: { title: 'Sessions keys · ? every key' } });
    d.send(key('<Esc>'), { ...HERE, here: {} }, key('?'));
    expect(d.tree).toMatchObject({ props: { title: 'Abe view keys · ? every key' } });
  });

  test("Run in Neovim: the text to Neovim's own command line", () => {
    const d = drive();

    d.send({ ...HERE, here: {}, ex: ['write'] }, key(':'), helpAnswer(), ...typed('w'));
    expect(props(d.tree)).toMatchObject({ selected: 'here:ex' });
    expect(d.send(key('<CR>'))).toEqual([{ kind: 'shell', effect: { kind: 'ex', text: 'w' } }]);
  });
});
