/**
 * The Board On this Mac at its port: a folder in a temp dir, a fake clock, the contract rows
 * (what a list shows, the states, a new card, comments, what changed, the files) and the router
 * that sends each call to this board or to Azure DevOps'.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AssignTo,
  type Board,
  type Boarded,
  type BoardRef,
  boardOf,
  type CardData,
  type DoneCards,
  type NewCard,
  type Person,
} from '@abe/core';
import { fakeClock } from '@abe/testing';
import { boardsByKind, localBoard } from './local-board';

const ME: Person = { name: 'Ada', email: 'ada@example.test' };
const BOB: Person = { name: 'Bob', email: 'bob@example.test' };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const refOf = (setting: unknown): BoardRef => {
  const r = boardOf(setting);

  if (!r.ok) throw new Error(r.error.message);

  return r.board;
};
const REF = refOf({ provider: 'local', project: 'Demo' });

const dirs: string[] = [];

/** A board in a folder of its own on a clock of its own; `as` the same folder as someone else. */
const world = () => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-local-board-'));
  const clock = fakeClock();

  dirs.push(dir);
  const as = (me: Person) => localBoard({ dir, clock, me });

  return { dir, clock, board: as(ME), as };
};
type World = ReturnType<typeof world>;

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ok = <T>(got: Boarded<T>): T => {
  if (!got.ok) throw new Error(`${got.error.code}: ${got.error.message}`);

  return got.data;
};

const card = (title: string, more: Partial<NewCard> = {}): NewCard => ({
  title,
  description: '',
  acceptanceCriteria: '',
  ...more,
});

const ids = (cards: readonly { id: number }[]) => cards.map((c) => c.id);

/** Each step a minute on, so the cards' change times follow their ids. */
const step = async <T>(w: World, then: () => Promise<Boarded<T>>): Promise<T> => {
  w.clock.tick(MINUTE);

  return ok(await then());
};

/**
 * A board with every kind of card: 1 an old done one, 2 an old declined prototype (both 15 days
 * back), then open: 3 plain, 4 assigned to you, 5 to Bob, 6 your prototype nobody took, 7 Bob's;
 * and 8 done now, 9 your declined prototype, 10 removed.
 */
const seeded = async (): Promise<World> => {
  const w = world();
  const { board, as } = w;
  const made = (title: string, more?: Partial<NewCard>) =>
    step(w, () => board.create(REF, card(title, more)));
  const move = (id: number, state: string) => step(w, () => board.move(REF, id, state));
  const prototype = { tags: ['prototype'] };

  await made('old done');
  await move(1, 'Closed');
  await made('old declined', prototype);
  await move(2, 'Removed');
  w.clock.tick(15 * DAY);
  await made('plain');
  await made('yours', { assignee: 'me' });
  await made('Bob’s');
  await step(w, () => board.assign(REF, 5, { kind: 'member', login: BOB.email }));
  await made('your prototype', prototype);
  await step(w, () => as(BOB).create(REF, card('Bob’s prototype', prototype)));
  await made('done');
  await move(8, 'Closed');
  await made('declined', prototype);
  await move(9, 'Removed');
  await made('removed');
  await move(10, 'Removed');

  return w;
};

describe('list on a board On this Mac', () => {
  const days = (n: number): DoneCards => ({ days: n });
  const rows: [string, { mine: boolean; iteration?: string; done?: DoneCards }, number[]][] = [
    ['the open cards, newest change first', { mine: false }, [7, 6, 5, 4, 3]],
    ['mine: assigned to you (your prototype nobody took is not)', { mine: true }, [4]],
    [
      'done within the days, a removed card never',
      { mine: false, done: days(14) },
      [8, 7, 6, 5, 4, 3],
    ],
    ['done within more days', { mine: false, done: days(30) }, [8, 7, 6, 5, 4, 3, 1]],
    ['mine with the done ones', { mine: true, done: days(14) }, [4]],
    [
      'the done cards of a sprint: there are none',
      { mine: false, done: { iteration: 'Demo\\Sprint 1' } },
      [7, 6, 5, 4, 3],
    ],
    ['an iteration: no card is in one', { mine: false, iteration: 'Demo\\Sprint 1' }, []],
  ];

  test.each(rows)('%s', async (_, query, expected) => {
    const { board } = await seeded();

    expect(ids(ok(await board.list(REF, query)))).toEqual(expected);
  });

  test('a board with no file lists no card', async () => {
    expect(ok(await world().board.list(REF, { mine: false }))).toEqual([]);
  });

  test('the sprint: none', async () => {
    expect(ok(await world().board.currentSprint(REF))).toBeNull();
  });
});

describe('moving a card', () => {
  const rows: [string, string, string | null][] = [
    ['a state', 'Active', 'Active'],
    ['a state in other case', 'resolved', 'Resolved'],
    ['done', 'Closed', 'Closed'],
    ['removed', 'Removed', 'Removed'],
    ['a state the board has not', 'Doing', null],
    ['Scrum’s done', 'Done', null],
  ];

  test.each(rows)('%s', async (_, state, kept) => {
    const { board } = world();

    ok(await board.create(REF, card('one')));
    const moved = await board.move(REF, 1, state);

    if (kept === null) {
      expect(moved).toEqual({
        ok: false,
        error: {
          code: 'rejected',
          message: `'${state}' is not a state of AB#1 (a User Story): New, Active, Resolved, Closed, Removed`,
        },
      });
      expect(ok(await board.show(REF, 1)).state).toBe('New');
    } else {
      expect(ok(moved).state).toBe(kept);
      expect(ok(await board.show(REF, 1)).state).toBe(kept);
    }
  });
});

describe('creating a card', () => {
  const rows: [string, NewCard, Partial<CardData>][] = [
    [
      'the defaults: the first type, New, no one, you made it',
      card('First'),
      {
        id: 1,
        title: 'First',
        type: 'User Story',
        state: 'New',
        tags: [],
        assignee: null,
        createdBy: ME,
        points: null,
        url: 'local:Demo#1',
      },
    ],
    ['a type of the board', card('Broken', { type: 'Bug' }), { type: 'Bug' }],
    ['a state', card('Going', { state: 'Active' }), { state: 'Active' }],
    ['assigned to you', card('Mine', { assignee: 'me' }), { assignee: ME }],
    ['assigned to no one', card('Nobody’s', { assignee: 'none' }), { assignee: null }],
    ['a sprint is ignored', card('Sprinted', { sprint: 'current' }), { state: 'New' }],
    [
      'tags and long fields',
      card('Told', {
        tags: ['prototype', 'web'],
        description: 'Why',
        acceptanceCriteria: 'It works',
      }),
      { tags: ['prototype', 'web'], description: 'Why', acceptanceCriteria: 'It works' },
    ],
  ];

  test.each(rows)('%s', async (_, input, expected) => {
    const { board } = world();

    expect(ok(await board.create(REF, input))).toMatchObject(expected);
  });

  const refused: [string, NewCard, string][] = [
    [
      'a type the board has not',
      card('Odd', { type: 'Epic' }),
      "'Epic' is not a type of this board: User Story, Bug",
    ],
    [
      'a state it has not',
      card('Odd', { state: 'Doing' }),
      "'Doing' is not a state of a User Story: New, Active, Resolved, Closed, Removed",
    ],
  ];

  test.each(refused)('%s: rejected, nothing kept', async (_, input, message) => {
    const { board } = world();

    expect(await board.create(REF, input)).toEqual({
      ok: false,
      error: { code: 'rejected', message },
    });
    expect(ok(await board.list(REF, { mine: false }))).toEqual([]);
  });

  test('ids rise from 1 on each board', async () => {
    const { board } = world();
    const other = refOf({ provider: 'local', project: 'Other' });

    expect([
      ok(await board.create(REF, card('a'))).id,
      ok(await board.create(REF, card('b'))).id,
      ok(await board.create(other, card('c'))).id,
    ]).toEqual([1, 2, 1]);
    expect(ok(await board.show(other, 1)).url).toBe('local:Other#1');
  });
});

describe('comments', () => {
  test('by you, the ids rising on the board, oldest first', async () => {
    const w = world();

    await step(w, () => w.board.create(REF, card('a')));
    await step(w, () => w.board.create(REF, card('b')));
    const first = await step(w, () => w.board.comment(REF, 1, 'one'));
    const second = await step(w, () => w.board.comment(REF, 2, 'two'));
    const third = await step(w, () => w.board.comment(REF, 1, 'three'));

    expect([first, second, third]).toEqual([
      { card: 1, id: 1, text: 'one', by: 'Ada', at: '2026-10-01T09:03:00.000Z' },
      { card: 2, id: 2, text: 'two', by: 'Ada', at: '2026-10-01T09:04:00.000Z' },
      { card: 1, id: 3, text: 'three', by: 'Ada', at: '2026-10-01T09:05:00.000Z' },
    ]);
    expect(ok(await w.board.show(REF, 1)).comments.map((c) => c.text)).toEqual(['one', 'three']);
  });
});

describe('a card changed', () => {
  const rows: [string, (b: Board) => Promise<Boarded<CardData>>, Partial<CardData>][] = [
    [
      'tags added',
      (b) => b.tag(REF, 1, { add: ['web', 'prototype'], remove: [] }),
      { tags: ['web', 'prototype'] },
    ],
    ['a tag taken off', (b) => b.tag(REF, 1, { add: [], remove: ['WEB'] }), { tags: [] }],
    ['assigned to you', (b) => b.assign(REF, 1, { kind: 'me' }), { assignee: ME }],
    [
      'assigned to no one',
      async (b) => {
        await b.assign(REF, 1, { kind: 'me' });

        return b.assign(REF, 1, { kind: 'none' });
      },
      { assignee: null },
    ],
    [
      'assigned to a teammate by login',
      (b) => b.assign(REF, 1, { kind: 'member', login: 'bob@example.test' } satisfies AssignTo),
      { assignee: { name: 'bob@example.test', email: 'bob@example.test' } },
    ],
    ['moved', (b) => b.move(REF, 1, 'Active'), { state: 'Active' }],
    [
      'its given fields written, the others left',
      (b) => b.write(REF, 1, { title: 'Renamed', description: 'New words' }),
      { title: 'Renamed', description: 'New words', acceptanceCriteria: 'Old criteria' },
    ],
  ];

  test.each(rows)('%s: kept, and the card is the newest change', async (_, change, expected) => {
    const w = world();

    await step(w, () =>
      w.board.create(
        REF,
        card('one', { description: 'Old', acceptanceCriteria: 'Old criteria', tags: ['web'] }),
      ),
    );
    await step(w, () => w.board.create(REF, card('two')));
    const changed = await step(w, () => change(w.board));

    expect(changed).toMatchObject(expected);
    expect(ok(await w.board.show(REF, 1))).toMatchObject(expected);
    expect(ids(ok(await w.board.list(REF, { mine: false })))).toEqual([1, 2]);
  });

  const same: [string, (b: Board) => Promise<Boarded<CardData>>][] = [
    ['a tag it has', (b) => b.tag(REF, 1, { add: ['WEB'], remove: ['nope'] })],
    ['its state', (b) => b.move(REF, 1, 'New')],
  ];

  test.each(same)('%s: not a change', async (_, change) => {
    const w = world();

    await step(w, () => w.board.create(REF, card('one', { tags: ['web'] })));
    await step(w, () => w.board.create(REF, card('two')));
    await step(w, () => change(w.board));

    expect(ids(ok(await w.board.list(REF, { mine: false })))).toEqual([2, 1]);
  });

  test('a comment is a change', async () => {
    const w = world();

    await step(w, () => w.board.create(REF, card('one')));
    await step(w, () => w.board.create(REF, card('two')));
    await step(w, () => w.board.comment(REF, 1, 'hello'));

    expect(ids(ok(await w.board.list(REF, { mine: false })))).toEqual([1, 2]);
  });
});

describe('changes since the last look', () => {
  type Edit = (w: World) => Promise<unknown>;
  const rows: [string, Edit, [number, boolean][], number[]][] = [
    ['nothing changed', () => Promise.resolve(), [], []],
    ['a card moved', (w) => w.board.move(REF, 1, 'Active'), [[1, false]], []],
    [
      'a card assigned to you is mine',
      (w) => w.board.assign(REF, 1, { kind: 'me' }),
      [[1, true]],
      [],
    ],
    ['a card done is still listed', (w) => w.board.move(REF, 1, 'Closed'), [[1, false]], []],
    ['a card removed is gone', (w) => w.board.move(REF, 1, 'Removed'), [], [1]],
    [
      'two cards, newest first',
      async (w) => {
        await step(w, () => w.board.move(REF, 1, 'Active'));
        await step(w, () => w.board.move(REF, 2, 'Active'));
      },
      [
        [2, false],
        [1, false],
      ],
      [],
    ],
    [
      'a card moved and another removed',
      async (w) => {
        await step(w, () => w.board.move(REF, 2, 'Removed'));
        await step(w, () => w.board.move(REF, 1, 'Active'));
      },
      [[1, false]],
      [2],
    ],
    ['a new card', (w) => w.board.create(REF, card('three')), [[3, false]], []],
  ];

  test.each(rows)('%s', async (_, edit, cards, gone) => {
    const w = world();

    await step(w, () => w.board.create(REF, card('one')));
    await step(w, () => w.board.create(REF, card('two')));
    const first = ok(await w.board.changes(REF, null));

    w.clock.tick(MINUTE);
    await edit(w);
    w.clock.tick(MINUTE);
    const looked = ok(await w.board.changes(REF, first.at));

    expect(looked.cards.map((c) => [c.card.id, c.mine])).toEqual(cards);
    expect(looked.gone).toEqual(gone);
    expect(looked.at).toBe(new Date(w.clock.now()).toISOString());
  });

  test('no since: nothing, only where the next look starts', async () => {
    const w = await seeded();

    expect(ok(await w.board.changes(REF, null))).toEqual({
      at: new Date(w.clock.now()).toISOString(),
      cards: [],
      gone: [],
    });
  });

  test('a since that is no time: rejected', async () => {
    expect(await world().board.changes(REF, 'yesterday')).toEqual({
      ok: false,
      error: { code: 'rejected', message: 'not a time: yesterday' },
    });
  });
});

describe('a card that is not there', () => {
  const rows: [string, (b: Board) => Promise<Boarded<unknown>>][] = [
    ['show', (b) => b.show(REF, 7)],
    ['comment', (b) => b.comment(REF, 7, 'hi')],
    ['tag', (b) => b.tag(REF, 7, { add: ['a'], remove: [] })],
    ['move', (b) => b.move(REF, 7, 'Active')],
    ['assign', (b) => b.assign(REF, 7, { kind: 'me' })],
    ['write', (b) => b.write(REF, 7, { title: 'x' })],
    ['attach', (b) => b.attach(REF, 7, { name: 'a.png', bytes: new Uint8Array([1]) })],
  ];

  test.each(rows)('%s: not-found', async (_, call) => {
    expect(await call(world().board)).toEqual({
      ok: false,
      error: { code: 'not-found', message: "AB#7 is not on this machine's board Demo" },
    });
  });
});

describe('the rest of the board', () => {
  test('members: you; me: you', async () => {
    const { board } = world();

    expect(ok(await board.members(REF))).toEqual([{ ...ME, you: true }]);
    expect(ok(await board.me(REF))).toEqual(ME);
  });

  test('image: rejected, there are none to read', async () => {
    expect(await world().board.image(REF, 'https://example.test/a.png')).toEqual({
      ok: false,
      error: { code: 'rejected', message: 'a board On this machine has no images to read' },
    });
  });
});

describe('files', () => {
  const rows: [string, string, string][] = [
    ['a file', 'shot.png', '1-shot.png'],
    ['a name with folders and spaces', '../../a b/shot one.png', '1-shot_one.png'],
    ['a hidden name', '.env', '1-env'],
  ];

  test.each(rows)(
    'attach %s: copied under the board’s files, answered as file://',
    async (_, name, kept) => {
      const { board, dir } = world();

      ok(await board.create(REF, card('one')));
      const { url } = ok(await board.attach(REF, 1, { name, bytes: new Uint8Array([1, 2, 3]) }));
      const path = join(dir, 'files', 'demo', kept);

      expect(url).toBe(`file://${path}`);
      expect(fileURLToPath(url)).toBe(path);
      expect([...readFileSync(path)]).toEqual([1, 2, 3]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  test('the board is one file named by its project, owner only, and read back by another board', async () => {
    const w = world();

    ok(await w.board.create(refOf({ provider: 'local', project: 'My Board!' }), card('one')));
    const file = join(w.dir, 'my-board.json');

    expect(readdirSync(w.dir)).toEqual(['my-board.json']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(w.dir).mode & 0o777).toBe(0o700);
    expect(
      ids(
        ok(
          await w.as(BOB).list(refOf({ provider: 'local', project: 'My Board!' }), { mine: false }),
        ),
      ),
    ).toEqual([1]);
  });

  const broken: [string, string][] = [
    ['not JSON', '{ nope'],
    ['not a board', '{"cards":[{"id":"one"}]}'],
  ];

  test.each(broken)(
    'a file that is %s: rejected by every call, never thrown, left as it is',
    async (_, text) => {
      const w = world();
      const file = join(w.dir, 'demo.json');

      mkdirSync(w.dir, { recursive: true });
      writeFileSync(file, text);
      const answers = [
        await w.board.list(REF, { mine: false }),
        await w.board.show(REF, 1),
        await w.board.create(REF, card('one')),
        await w.board.changes(REF, new Date(0).toISOString()),
      ];

      for (const a of answers) expect(a).toMatchObject({ ok: false, error: { code: 'rejected' } });
      expect(readFileSync(file, 'utf8')).toBe(text);
    },
  );
});

describe('the router', () => {
  /** A board that answers every call refused with its own name, and says it was called. */
  const named = (name: string): Board => {
    const said = () =>
      Promise.resolve({ ok: false, error: { code: 'rejected', message: name } } as const);

    return {
      list: said,
      currentSprint: said,
      changes: said,
      show: said,
      image: said,
      comment: said,
      tag: said,
      move: said,
      assign: said,
      members: said,
      me: said,
      create: said,
      attach: said,
      write: said,
    };
  };

  const AZURE = refOf({
    organization: 'https://dev.azure.com/demo-org',
    project: 'Sandbox',
    team: 'Sandbox',
  });
  const calls: [string, (b: Board, ref: BoardRef) => Promise<Boarded<unknown>>][] = [
    ['list', (b, r) => b.list(r, { mine: false })],
    ['currentSprint', (b, r) => b.currentSprint(r)],
    ['changes', (b, r) => b.changes(r, null)],
    ['show', (b, r) => b.show(r, 1)],
    ['image', (b, r) => b.image(r, 'https://example.test/a.png')],
    ['comment', (b, r) => b.comment(r, 1, 'hi')],
    ['tag', (b, r) => b.tag(r, 1, { add: [], remove: [] })],
    ['move', (b, r) => b.move(r, 1, 'Active')],
    ['assign', (b, r) => b.assign(r, 1, { kind: 'me' })],
    ['members', (b, r) => b.members(r)],
    ['me', (b, r) => b.me(r)],
    ['create', (b, r) => b.create(r, card('one'))],
    ['attach', (b, r) => b.attach(r, 1, { name: 'a.png', bytes: new Uint8Array() })],
    ['write', (b, r) => b.write(r, 1, { title: 'x' })],
  ];

  test.each(calls)(
    '%s: a board On this machine to local, any other to Azure DevOps',
    async (_, call) => {
      const routed = boardsByKind({ azure: named('azure'), local: named('local') });

      expect(await call(routed, REF)).toMatchObject({ error: { message: 'local' } });
      expect(await call(routed, AZURE)).toMatchObject({ error: { message: 'azure' } });
    },
  );
});
