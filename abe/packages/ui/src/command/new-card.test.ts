/**
 * The New card dialog (#346) through Command mode: opened by a screen, typed into, its picks, the
 * agent's draft, Create, a refusal kept, the form kept per board after Esc and gone once made.
 */
import { describe, expect, test } from 'bun:test';
import { type CardData } from '@abe/core';
import { commandMode } from './command';
import { type Node } from '../runtime/components';
import { createArgv, freshForm, NEW_CARD_MENU, type NewCardOn } from './new-card';
import { type Answer, type Command, type Input, mountLayer } from '../runtime/runtime';

const ON: NewCardOn = {
  kind: 'newcard',
  board: 'demo-org/Shop/Shop',
  types: ['User Story', 'Bug'],
  columns: ['New', 'Active', 'Resolved', 'Closed'],
  sprint: 'Sprint 14',
};

const key = (k: string): Input => ({ kind: 'key', key: k });
const typed = (text: string): Input[] => Array.from(text, (ch) => key(ch === ' ' ? '<Space>' : ch));

const drive = () => {
  const layer = mountLayer(commandMode([]));
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

type Props = Record<string, unknown> & {
  title: string;
  sections: { title: string; note?: string; markdown: string }[];
  buttons: { id: string; label: string; reason?: string }[];
  error?: string;
  state: string;
};

const dialog = (d: ReturnType<typeof drive>): Props => {
  const t = d.tree;

  if (t?.kind !== 'CardDialog') throw new Error(`no New card dialog up: ${t?.kind ?? 'none'}`);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the CardDialog's props, checked by kind above
  return t.props as unknown as Props;
};

const runOf = (commands: readonly Command[]) => {
  const run = commands.find((c) => c.kind === 'run');

  if (run?.kind !== 'run') throw new Error('nothing ran');

  return run;
};

const CARD: CardData = {
  id: 1301,
  title: 'Customers can save a wishlist',
  state: 'New',
  type: 'User Story',
  tags: [],
  assignee: { name: 'Alex Example', email: 'alex@example.test' },
  description: '',
  acceptanceCriteria: '',
  points: null,
  createdBy: null,
  url: 'https://dev.azure.com/demo-org/Shop/_workitems/edit/1301',
};

const created = (id: string, card: CardData = CARD): Answer => ({
  kind: 'result',
  id,
  command: 'card create',
  reply: { ok: true, data: card },
});

const refusedWith = (id: string, message: string): Answer => ({
  kind: 'result',
  id,
  command: 'card create',
  reply: { ok: false, error: { code: 'rejected', message } },
});

describe('the New card dialog (#346)', () => {
  test('opens on the title typed: the board’s first type, New, Me, the current sprint', () => {
    const d = drive();

    d.send({ ...ON, title: 'Customers can save a wishlist' });
    const p = dialog(d);

    expect(p.kicker).toBe('New card');
    expect(p.title).toBe('Customers can save a wishlist▏');
    expect(p.sections[0]?.markdown).toBe(
      'Type User Story ▾ · Column New ▾ · Assignee Me ▾ · Sprint Sprint 14 ▾',
    );
    expect(p.buttons.map((b) => [b.label, b.reason])).toEqual([
      ['Draft with the agent', undefined],
      ['Create', undefined],
    ]);
  });

  test('every letter types into the title, k l ö ä too; an empty title greys both buttons', () => {
    const d = drive();

    d.send(ON);
    expect(dialog(d).buttons.every((b) => b.reason === 'give it a title')).toBe(true);
    d.send(...typed('look at klöä'));
    expect(dialog(d).title).toBe('look at klöä▏');
    // ⏎ on an empty title makes nothing
    const d2 = drive();

    d2.send(ON);
    expect(d2.send(key('<CR>'))).toEqual([]);
  });

  test('Tab moves to the picks: ⏎ opens its pick, a row chosen sets it, the keys back on it', () => {
    const d = drive();

    d.send({ ...ON, title: 'x' }, key('<Tab>'), key('<Tab>'));
    expect(dialog(d).sections[0]?.markdown).toContain('**▸ Column New ▾**');
    d.send(key('<CR>'));
    expect(d.tree?.kind).toBe('PickLayer');
    expect(d.tree?.props).toMatchObject({ title: 'Column' });
    // ↓ moves (every letter types in a pick), ⏎ chooses Active
    d.send(key('<Down>'), key('<CR>'));
    expect(dialog(d).sections[0]?.markdown).toContain('**▸ Column Active ▾**');
    // Esc in a pick goes back to the dialog, nothing set
    d.send(key('<Tab>'), key('<CR>'), key('<Down>'), key('<Esc>'));
    expect(dialog(d).sections[0]?.markdown).toContain('**▸ Assignee Me ▾**');
  });

  test('Description and criteria: ⇧⏎ a new line; Create sends every field inline', () => {
    const d = drive();

    d.send({ ...ON, title: 'A wishlist' });
    for (let i = 0; i < 5; i += 1) d.send(key('<Tab>'));
    d.send(...typed('## Why'), key('<S-CR>'), ...typed('They lose it.'), key('<Tab>'));
    d.send(...typed('- [ ] A heart saves it'));
    expect(dialog(d).sections[1]?.markdown).toBe('## Why\nThey lose it.');
    expect(dialog(d).sections[2]?.markdown).toBe('- [ ] A heart saves it▏');
    const out = d.send(key('<CR>'));

    expect(runOf(out).argv).toEqual([
      'card',
      'create',
      '--title=A wishlist',
      '--state=New',
      '--assign=me',
      '--sprint=current',
      '--description=## Why\nThey lose it.',
      '--criteria=- [ ] A heart saves it',
    ]);
    expect(dialog(d).buttons.find((b) => b.label === 'Create')?.reason).toBe('creating');
  });

  test('on a pick, words typed go to Description: Space never opens the pick, no letter is lost', () => {
    const d = drive();

    d.send({ ...ON, title: 'x' }, key('<Tab>'), key('<Tab>'));
    d.send(...typed('Show the count'));
    expect(d.tree?.kind).toBe('CardDialog');
    expect(dialog(d).sections[1]).toMatchObject({
      title: '▸ Description',
      markdown: 'Show the count▏',
    });
    expect(dialog(d).sections[0]?.markdown).toContain('Column New ▾');
  });

  test('a board on this machine: no Azure, no sprint', () => {
    const d = drive();

    d.send({ ...ON, sprint: null, onThisMachine: true, title: 'A local one' });
    expect(dialog(d).state).toBe('On this machine · draft');
    expect(dialog(d).sections[0]).toMatchObject({
      title: 'Type · Column · Assignee',
      markdown: 'Type User Story ▾ · Column New ▾ · Assignee Me ▾',
    });
    // Tab: title, the three picks, Description
    d.send(key('<Tab>'), key('<Tab>'), key('<Tab>'), key('<Tab>'));
    expect(dialog(d).sections[1]?.title).toBe('▸ Description');
    expect(runOf(d.send(key('<CR>'))).argv.some((a) => a.startsWith('--sprint'))).toBe(false);
  });

  test('made: closed, the status line says so, the Board told to select it; the next one opens empty', () => {
    const d = drive();

    d.send({ ...ON, title: 'Customers can save a wishlist' });
    const run = runOf(d.send(key('<CR>')));
    const out = d.send(created(run.id));

    expect(d.tree).toBeUndefined();
    expect(out).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'status', text: 'Made #1301 Customers can save a wishlist' },
      },
      { kind: 'choice', menu: NEW_CARD_MENU, row: 'made:1301:me' },
    ]);
    d.send(ON);
    expect(dialog(d).title).toBe('▏');
  });

  test('refused: the dialog stays with why in red; Esc keeps the form for its board', () => {
    const d = drive();

    d.send({ ...ON, title: 'A bug' });
    const run = runOf(d.send(key('<CR>')));

    d.send(refusedWith(run.id, "'Active' is not a state of a Bug"));
    expect(dialog(d).error).toBe("'Active' is not a state of a Bug (rejected)");
    expect(dialog(d).title).toBe('A bug▏');
    d.send(key('<Esc>'));
    expect(d.tree).toBeUndefined();
    d.send(ON);
    expect(dialog(d).title).toBe('A bug▏');
    // another board's dialog is its own
    d.send(key('<Esc>'), { ...ON, board: 'other/Shop/Shop' });
    expect(dialog(d).title).toBe('▏');
  });

  test('⌘⏎ drafts with the agent: from the title, then from its earlier draft', () => {
    const d = drive();

    d.send({ ...ON, title: 'save a wishlist', session: 'ask-1' });
    const first = runOf(d.send(key('<D-CR>')));

    expect(first.argv).toEqual(['card', 'draft', '--session', 'ask-1', '--', 'save a wishlist']);
    expect(first.id).toBe(`newcard:draft:1:${ON.board}`);
    expect(dialog(d).state).toBe('drafting…');
    const draft = {
      title: 'Customers can save a wishlist',
      why: 'They lose what they liked.',
      what: 'A heart saves it.',
      criteria: ['A heart saves the product'],
    };

    d.send({
      kind: 'result',
      id: first.id,
      command: 'card draft',
      reply: { ok: true, data: draft },
    });
    const p = dialog(d);

    expect(p.title).toBe('save a wishlist▏');
    expect(p.sections[1]?.markdown).toBe(
      '## Why\n\nThey lose what they liked.\n\n## What\n\nA heart saves it.',
    );
    expect(p.sections[2]?.markdown).toBe('- [ ] A heart saves the product');
    // a criterion edited, then drafted again: the draft as edited goes back
    d.send(key('<Tab>'), key('<Tab>'), key('<Tab>'), key('<Tab>'), key('<Tab>'), key('<Tab>'));
    d.send(...typed(' first'));
    const again = runOf(d.send(key('<D-CR>')));

    expect(again.argv).toContain(
      `--earlier=${JSON.stringify({ ...draft, title: 'save a wishlist', criteria: ['A heart saves the product first'] })}`,
    );
  });

  test('Esc while it is being created: it stays up for the answer, never made twice', () => {
    const d = drive();

    d.send({ ...ON, title: 'Once' });
    const run = runOf(d.send(key('<CR>')));

    expect(d.send(key('<Esc>'))).toEqual([]);
    expect(dialog(d).title).toBe('Once▏');
    expect(d.send(key('<CR>'))).toEqual([]);
    d.send({ kind: 'blur' });
    expect(dialog(d).title).toBe('Once▏');
    d.send(created(run.id));
    expect(d.tree).toBeUndefined();
  });

  test('a draft answered after its dialog closed fills its own board’s form, not the one up', () => {
    const d = drive();

    d.send({ ...ON, title: 'Mine' });
    const run = runOf(d.send(key('<D-CR>')));

    d.send(key('<Esc>'), { ...ON, board: 'other/Shop/Shop', title: 'Theirs' });
    d.send({
      kind: 'result',
      id: run.id,
      command: 'card draft',
      reply: { ok: true, data: { title: 'Mine', why: 'W', what: 'X', criteria: ['C'] } },
    });
    expect(dialog(d).title).toBe('Theirs▏');
    expect(dialog(d).sections[2]?.markdown).toBe('');
    d.send(key('<Esc>'), ON);
    expect(dialog(d).sections[2]?.markdown).toBe('- [ ] C');
  });

  test('a paste into the title is one line', () => {
    const d = drive();

    d.send(ON, { kind: 'text', text: 'Save\na wishlist\n' });
    expect(dialog(d).title).toBe('Save a wishlist ▏');
  });

  test('a ⏎ held from the `:` line creates nothing while the dialog is new (#285)', () => {
    const d = drive();

    d.send({ kind: 'tick', at: '2026-10-25T10:00:00.000Z' }, { ...ON, title: 'x' });
    d.send({ kind: 'tick', at: '2026-10-25T10:00:00.100Z' });
    expect(d.send(key('<CR>'))).toEqual([]);
    d.send({ kind: 'tick', at: '2026-10-25T10:00:01.000Z' });
    expect(runOf(d.send(key('<CR>'))).argv[1]).toBe('create');
  });
});

describe('createArgv', () => {
  test('the board’s first type is left to the board; another is named', () => {
    const form = freshForm({ ...ON, title: 't' });

    expect(createArgv({ on: ON, form })).not.toContain('--type=User Story');
    expect(createArgv({ on: ON, form: { ...form, type: 'Bug' } })).toContain('--type=Bug');
    const none = createArgv({ on: ON, form: { ...form, assignee: 'none', sprint: 'none' } });

    expect(none).toContain('--assign=none');
    expect(none).toContain('--sprint=none');
  });
});
