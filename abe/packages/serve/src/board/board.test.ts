/**
 * `abe card` on an in-process `serve` (`served`; the real `abe` and its `serve` for card create's
 * one-shot `claude`): the real Azure DevOps adapter, the fake Azure DevOps as its own process on a
 * free port (seeded from `testing`'s seed) and a fake `az` handing out tokens. The board comes
 * from the repo's `board` setting.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { adoBoardFrom } from '@abe/ports';
import {
  CardCommentData,
  CardData,
  CardDraftData,
  CardImagesData,
  CardListData,
  CardMembersData,
  CardShowData,
  FactoryRunData,
} from '@abe/core';
import {
  ADO_SEED,
  boardLayers,
  cli,
  type Cli,
  served,
  tempState,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  ghIssue,
  ghUser,
  macServed,
  oneShotCalls,
  scriptOneShot,
  T0,
} from '@abe/testing';

const AZ_ARGV = [
  'account',
  'get-access-token',
  '--resource',
  '499b84ac-1321-427f-aa17-267ca6975798',
  '-o',
  'json',
];

/** A CLI on the fake, with `az` handing out `tokens` and the fake refusing `expired` ones. */
const world = async (o: {
  tokens: string[];
  expired?: string[];
  board?: unknown;
  env?: Record<string, string>;
  seed?: string;
  /** Folders put before az's on the PATH (a fake `claude`). */
  path?: string;
  /** The real `abe` and its `serve` (`cli`): card create's one-shot `claude` is serve's own. */
  real?: true;
}) => {
  const ado = await fakeAdo({
    ...(o.expired === undefined ? {} : { expired: o.expired }),
    ...(o.seed === undefined ? {} : { seed: o.seed }),
  });
  const az = fakeAz({ tokens: o.tokens });
  const files = boardLayers(o.board ?? ado.board);
  const PATH = o.path === undefined ? az.path : `${o.path}:${az.path}`;
  const env = { PATH, ...files.env, ...ado.env, ...o.env };
  const state = tempState();
  const abe: Reads =
    o.real === true
      ? cli({ env, cwd: files.repo })
      : await served({
          cwd: files.repo,
          state,
          env,
          board: adoBoardFrom({ ...state.env, ...env }, join(state.dir, 'images')),
        });

  if (o.real === true) state.remove();

  return {
    ado,
    az,
    abe,
    /** The board's checkout: where commands are typed, and a body file is read from. */
    repo: files.repo,
    close: async () => {
      await abe.close();
      await ado.stop();
      az.remove();
      files.remove();
    },
  };
};

/** What a test reads through: in process or the real `abe`. */
type Reads = Pick<Cli, 'state' | 'run' | 'json' | 'close'>;

const ids = (cards: readonly { id: number }[]) => cards.map((c) => c.id);

describe('abe card on the fake board', () => {
  let w: Awaited<ReturnType<typeof world>>;
  let abe: Reads;
  let ado: FakeAdo;
  let az: FakeAz;

  beforeAll(async () => {
    // A PAT in the environment would stand in for the person's az login.
    w = await world({ tokens: ['token-one'], env: { AZURE_DEVOPS_EXT_PAT: 'fake-pat' } });
    ({ abe, ado, az } = w);
  });
  afterAll(async () => {
    await w.close();
  });

  test('card list: the board’s open stories and bugs in the team’s areas', async () => {
    const { exit, doc } = await abe.json(CardListData, 'card', 'list');

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.board).toMatchObject({
      organization: 'https://dev.azure.com/demo-org',
      project: 'Sandbox',
      team: 'Sandbox',
    });
    expect(doc.data.mine).toBe(false);
    // 1–3 are an epic and features, 9 is closed, 10–12 are tasks.
    expect(ids(doc.data.cards)).toEqual([4, 5, 6, 7, 8, 13]);
    // each card's story points (#135); a bug and an unpointed story have none
    expect(doc.data.cards.map((c) => [c.id, c.points])).toEqual([
      [4, 5],
      [5, 3],
      [6, 8],
      [7, 5],
      [8, null],
      [13, null],
    ]);
    // The team's current sprint names the list (the Factory overview's header).
    expect(doc.data.sprint).toBe('Sprint 1');
    expect(ado.requests().some((r) => r.includes('/teamsettings/teamfieldvalues'))).toBe(true);
    expect(az.calls()).toEqual([AZ_ARGV]);
  });

  test('card list --mine: only the cards assigned to you', async () => {
    const { doc } = await abe.json(CardListData, 'card', 'list', '--mine');

    expect(doc).toMatchObject({ ok: true, data: { mine: true } });
    if (doc.ok) expect(ids(doc.data.cards)).toEqual([4]);
  });

  test('card list --closed: the sprint’s done cards too (#239); tasks and other sprints never', async () => {
    const { exit, doc } = await abe.json(CardListData, 'card', 'list', '--closed');

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    // 9 is the closed bug in Sprint 1; 12 a closed task
    expect(ids(doc.data.cards)).toEqual([4, 5, 6, 7, 8, 9, 13]);
    expect(doc.data.cards.find((c) => c.id === 9)?.state).toBe('Closed');
    expect(doc.data).toMatchObject({ closed: true, sprint: 'Sprint 1' });
    // as the Board reads Mine: none of yours is done
    const mine = await abe.json(CardListData, 'card', 'list', '--mine', '--closed');

    if (!mine.doc.ok) throw new Error(mine.doc.error.message);
    expect(ids(mine.doc.data.cards)).toEqual([4]);
  });

  test('card show: the card, its html as markdown, its comments', async () => {
    const { exit, doc } = await abe.json(CardShowData, 'card', 'show', 'AB#4');
    /** Each comment's time as the fake's clock (from `T0`) stamped it: three and two days ago. */
    const at = (n: number) => (doc.ok ? (doc.data.comments[n]?.at ?? '') : '');

    expect(doc.ok && doc.data.comments.map((c) => Date.parse(c.at))).toEqual([
      T0 - 3 * 86_400_000,
      T0 - 2 * 86_400_000,
    ]);

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        id: 4,
        title: 'As a visitor I can sign in with email',
        state: 'Active',
        type: 'User Story',
        tags: ['auth', 'web'],
        assignee: { name: 'Alex Example', email: 'alex@example.test' },
        description:
          '### Why\n\nVisitors need an account to see their *orders*.\n\n- email + password\n- remember me',
        acceptanceCriteria: '- A wrong password says so\n- Signed in, the header shows the name',
        url: 'https://dev.azure.com/demo-org/Sandbox/_workitems/edit/4',
        points: 5,
        createdBy: { name: 'Alex Example', email: 'alex@example.test' },
        comments: [
          { id: 1, text: 'Should we support **magic links** too?', by: 'Sam Sample', at: at(0) },
          { id: 2, text: 'Later, as its own story.', by: 'Alex Example', at: at(1) },
        ],
        sheets: [],
      },
    });
  });

  test('card show: a description kept as markdown, a bug’s repro steps, no assignee', async () => {
    const pay = await abe.json(CardShowData, 'card', 'show', '13');
    const bug = await abe.json(CardShowData, 'card', 'show', '8');
    const reset = await abe.json(CardShowData, 'card', 'show', '5');

    expect(pay.doc).toMatchObject({
      ok: true,
      data: { description: '## Why\n\nPaying takes <1 minute & no account.', tags: ['checkout'] },
    });
    expect(bug.doc).toMatchObject({
      ok: true,
      data: {
        type: 'Bug',
        description:
          '1. Open the start page at 360 px\n2. Look at the header\n\nThe `Sign in` button covers the logo.',
      },
    });
    expect(reset.doc).toMatchObject({
      ok: true,
      data: { assignee: null, description: '', acceptanceCriteria: '', comments: [] },
    });
  });

  test('card show as text', async () => {
    const out = await abe.run('card', 'show', '6');

    expect(out.exit).toBe(0);
    expect(out.stdout).toBe(
      [
        'AB#6 (Resolved) As a customer I see my last ten orders',
        'User Story · Robin Placeholder',
        'https://dev.azure.com/demo-org/Sandbox/_workitems/edit/6',
        '',
        'List with date, total and status. [Spec](https://example.test/spec).',
        '',
      ].join('\n'),
    );
  });

  test('card images (#238): the org’s attachment kept in the state folder; another host’s refused, unread', async () => {
    const bug = await abe.json(CardShowData, 'card', 'show', '8');

    if (!bug.doc.ok) throw new Error(bug.doc.error.message);
    const image = bug.doc.data.comments.at(-1)?.text.match(/!\[narrow\.png\]\((\S+)\)/)?.[1];

    expect(image).toStartWith('https://dev.azure.com/demo-org/Sandbox/_apis/wit/attachments/');
    const foreign = 'https://img.example/narrow.png';
    const before = ado.requests().length;
    const { exit, doc } = await abe.json(CardImagesData, 'card', 'images', image ?? '', foreign);

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    const [own, other] = doc.data.images;

    expect(own?.url).toBe(image);
    expect(own?.path).toStartWith(join(abe.state.dir, 'images'));
    expect(
      readFileSync(own?.path ?? '')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(other).toEqual({
      url: foreign,
      error:
        "not an attachment of https://dev.azure.com/demo-org: Abe reads only the board's own images",
    });
    // one read, of the org's attachment only
    expect(
      ado
        .requests()
        .slice(before)
        .map((r) => r.split('?')[0]),
    ).toEqual(['GET /demo-org/Sandbox/_apis/wit/attachments/5e0c7a3b-6d1f-4b8e-9a2c-0f4d3b2a1c90']);
  });

  test('a card that is not there is not-found; a bad id is a usage error', async () => {
    const missing = await abe.json(CardShowData, 'card', 'show', '999');
    const bad = await abe.json(CardShowData, 'card', 'show', 'four');

    expect(missing.exit).toBe(1);
    // said as such, never Azure DevOps' raw answer (#187)
    expect(missing.doc).toMatchObject({
      ok: false,
      error: {
        code: 'not-found',
        message: 'AB#999 does not exist in Sandbox, or you cannot see it',
      },
    });
    expect(bad.exit).toBe(2);
    expect(bad.doc).toMatchObject({ ok: false, error: { code: 'usage' } });
    // A comment on it too.
    writeFileSync(join(w.repo, 'nine.md'), 'hello\n');
    const commented = await abe.json(
      CardCommentData,
      'card',
      'comment',
      '999',
      '--body-file',
      'nine.md',
    );

    expect(commented.doc).toMatchObject({
      ok: false,
      error: {
        code: 'not-found',
        message: 'AB#999 does not exist in Sandbox, or you cannot see it',
      },
    });
  });

  test('card comment: the body file as markdown, seen on the next read', async () => {
    writeFileSync(join(w.repo, 'c.md'), 'Needs **design** first: x < y & z.\n');
    const { exit, doc } = await abe.json(
      CardCommentData,
      'card',
      'comment',
      '4',
      '--body-file',
      'c.md',
    );

    expect(exit).toBe(0);
    expect(doc).toMatchObject({
      ok: true,
      data: { card: 4, text: 'Needs **design** first: x < y & z.', by: 'Alex Example' },
    });
    const shown = await abe.json(CardShowData, 'card', 'show', '4');

    if (!shown.doc.ok) throw new Error(shown.doc.error.message);
    expect(shown.doc.data.comments.at(-1)).toMatchObject({
      text: 'Needs **design** first: x < y & z.',
    });
    expect(ado.requests().some((r) => /POST .*\/comments\?.*format=markdown/.test(r))).toBe(true);
  });

  test('card comment: an empty or missing body file is refused, nothing is posted', async () => {
    writeFileSync(join(w.repo, 'empty.md'), '  \n');
    const before = ado.requests().length;
    const empty = await abe.json(
      CardCommentData,
      'card',
      'comment',
      '4',
      '--body-file',
      'empty.md',
    );
    const missing = await abe.json(CardCommentData, 'card', 'comment', '4', '--body-file', 'no.md');

    expect(empty.doc).toMatchObject({ ok: false, error: { code: 'empty-body' } });
    expect(missing.doc).toMatchObject({ ok: false, error: { code: 'unreadable-body-file' } });
    expect(ado.requests().length).toBe(before);
  });

  test('card tag: added and taken off, case-blind, seen on the next read', async () => {
    const { exit, doc } = await abe.json(
      CardData,
      'card',
      'tag',
      '4',
      '--add',
      'needs-info',
      '--remove',
      'WEB',
    );

    expect(exit).toBe(0);
    expect(doc).toMatchObject({ ok: true, data: { id: 4, tags: ['auth', 'needs-info'] } });
    const shown = await abe.json(CardShowData, 'card', 'show', '4');

    expect(shown.doc).toMatchObject({ ok: true, data: { tags: ['auth', 'needs-info'] } });
    // The write is guarded by the revision it read.
    expect(ado.requests().filter((r) => r.startsWith('PATCH ')).length).toBe(1);
  });

  test('card tag needs --add or --remove', async () => {
    const { exit, doc } = await abe.json(CardData, 'card', 'tag', '4');

    expect(exit).toBe(2);
    expect(doc).toMatchObject({ ok: false, error: { code: 'usage' } });
  });

  test('card move: the state set, seen on the next read and in the list', async () => {
    const { exit, doc } = await abe.json(CardData, 'card', 'move', '5', 'Resolved');

    expect(exit).toBe(0);
    expect(doc).toMatchObject({ ok: true, data: { id: 5, state: 'Resolved' } });
    const shown = await abe.json(CardShowData, 'card', 'show', '5');

    expect(shown.doc).toMatchObject({ ok: true, data: { state: 'Resolved' } });
    const closed = await abe.json(CardData, 'card', 'move', '5', 'Closed');
    const listed = await abe.json(CardListData, 'card', 'list');

    expect(closed.doc).toMatchObject({ ok: true, data: { state: 'Closed' } });
    if (listed.doc.ok) expect(ids(listed.doc.data.cards)).not.toContain(5);
  });

  test('card move to a state the type has not is rejected, naming the states it has', async () => {
    const { exit, doc } = await abe.json(CardData, 'card', 'move', '7', 'Ready', 'for', 'test');

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'rejected' } });
    // with the states its type has (#187), not Azure DevOps' rule error
    if (!doc.ok)
      expect(doc.error.message).toMatch(
        /^'Ready for test' is not a state of AB#7 \(a [A-Za-z ]+\): New, Active, .*Closed/,
      );
  });

  test('card comment --text: the text, trimmed, as markdown, seen on the next read', async () => {
    const { exit, doc } = await abe.json(
      CardCommentData,
      'card',
      'comment',
      '7',
      '--text',
      '  Ready for **review**: a < b.\n',
    );

    expect(exit).toBe(0);
    expect(doc).toMatchObject({
      ok: true,
      data: { card: 7, text: 'Ready for **review**: a < b.' },
    });
    const shown = await abe.json(CardShowData, 'card', 'show', '7');

    if (!shown.doc.ok) throw new Error(shown.doc.error.message);
    expect(shown.doc.data.comments.at(-1)).toMatchObject({ text: 'Ready for **review**: a < b.' });
  });

  test('card comment takes --text or --body-file, exactly one; a blank --text is empty-body', async () => {
    writeFileSync(join(w.repo, 'one.md'), 'One.\n');
    const before = ado.requests().length;
    const neither = await abe.json(CardCommentData, 'card', 'comment', '7');
    const both = await abe.json(
      CardCommentData,
      'card',
      'comment',
      '7',
      '--text',
      'Two.',
      '--body-file',
      'one.md',
    );
    const blank = await abe.json(CardCommentData, 'card', 'comment', '7', '--text', '  ');

    for (const out of [neither, both]) {
      expect(out.exit).toBe(2);
      expect(out.doc).toMatchObject({ ok: false, error: { code: 'usage' } });
    }
    if (!both.doc.ok) expect(both.doc.error.message).toContain('not both');
    expect(blank.doc).toMatchObject({ ok: false, error: { code: 'empty-body' } });
    expect(ado.requests().length).toBe(before);
  });

  test('card assign <id> me: you, as Azure DevOps knows your login; then in card list --mine', async () => {
    const before = ado.requests().length;
    const { exit, doc } = await abe.json(CardData, 'card', 'assign', 'AB#13', 'me');

    expect(exit).toBe(0);
    expect(doc).toMatchObject({
      ok: true,
      data: { id: 13, assignee: { name: 'Alex Example', email: 'alex@example.test' } },
    });
    const sent = ado.requests().slice(before);

    expect(sent.filter((r) => r.startsWith('GET /demo-org/_apis/connectionData'))).toHaveLength(1);
    const patches = sent.filter((r) => r.startsWith('PATCH '));

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatch(/^PATCH \/demo-org\/Sandbox\/_apis\/wit\/workitems\/13\?.* → 200$/);
    const mine = await abe.json(CardListData, 'card', 'list', '--mine');

    if (!mine.doc.ok) throw new Error(mine.doc.error.message);
    expect(ids(mine.doc.data.cards).sort((a, b) => a - b)).toEqual([4, 13]);
  });

  test('card members: the team, you first, then by name; read as the team’s members', async () => {
    const before = ado.requests().length;
    const { exit, doc } = await abe.json(CardMembersData, 'card', 'members');

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        members: [
          { name: 'Alex Example', email: 'alex@example.test', you: true },
          { name: 'Robin Placeholder', email: 'robin@example.test', you: false },
          { name: 'Sam Sample', email: 'sam@example.test', you: false },
        ],
      },
    });
    expect(
      ado
        .requests()
        .slice(before)
        .filter((r) => r.startsWith('GET /demo-org/_apis/projects/Sandbox/teams/Sandbox/members')),
    ).toHaveLength(1);
    const text = await abe.run('card', 'members');

    expect(text.stdout).toBe(
      'Alex Example <alex@example.test>  (you)\nRobin Placeholder <robin@example.test>\nSam Sample <sam@example.test>\n',
    );
  });

  test('card assign <id> <teammate>: by email, name or email before the @; written as their login', async () => {
    for (const [who, name] of [
      ['sam', 'Sam Sample'],
      ['Robin Placeholder', 'Robin Placeholder'],
      ['SAM@example.test', 'Sam Sample'],
    ] as const) {
      const { exit, doc } = await abe.json(CardData, 'card', 'assign', '13', who);

      expect(exit).toBe(0);
      expect(doc).toMatchObject({ ok: true, data: { id: 13, assignee: { name } } });
    }
    const shown = await abe.json(CardShowData, 'card', 'show', '13');

    expect(shown.doc).toMatchObject({
      ok: true,
      data: { assignee: { name: 'Sam Sample', email: 'sam@example.test' } },
    });
  });

  test('card assign to no one on the team is refused, and nothing is written', async () => {
    const before = ado.requests().length;
    const { exit, doc } = await abe.json(CardData, 'card', 'assign', '13', 'kim');

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'not-a-member' } });
    if (!doc.ok) expect(doc.error.message).toContain('sam@example.test');
    expect(
      ado
        .requests()
        .slice(before)
        .filter((r) => r.startsWith('PATCH ')),
    ).toEqual([]);
  });

  test('card assign <id> none: no one; then me again', async () => {
    const none = await abe.json(CardData, 'card', 'assign', '13', 'none');

    expect(none.doc).toMatchObject({ ok: true, data: { id: 13, assignee: null } });
    const me = await abe.json(CardData, 'card', 'assign', '13', 'me');

    expect(me.doc).toMatchObject({ ok: true, data: { assignee: { name: 'Alex Example' } } });
  });

  test('one token from az for every command while it is good; never printed', async () => {
    expect(az.calls().length).toBe(1);
    const out = await abe.run('card', 'list');

    expect(`${out.stdout}${out.stderr}`).not.toContain('token-one');
    expect(ado.requests().join('\n')).not.toContain('token-one');
    expect(az.envs()[0]).toContain('HOME');
    expect(az.envs()[0]).not.toContain('AZURE_DEVOPS_EXT_PAT');
  });
});

describe('abe card create and draft (New card, #346)', () => {
  let w: Awaited<ReturnType<typeof world>>;
  let claude: FakeClaude;

  beforeAll(async () => {
    claude = fakeClaude();
    w = await world({ tokens: ['token-one'], path: claude.dir, real: true });
  });
  afterAll(async () => {
    await w.close();
    claude.remove();
  });

  const DRAFT: CardDraftData = {
    title: 'Customers can save a wishlist',
    why: 'Shoppers lose the products they liked.',
    what: 'A heart on each product saves it to a wishlist page.',
    criteria: ['A heart saves the product', 'The wishlist lists what was saved'],
  };

  test('card draft: the one-shot drafts from the words; again from the earlier draft; nothing written', async () => {
    const better = { ...DRAFT, why: 'Returning shoppers cannot find what they liked.' };

    scriptOneShot(w.abe.state.dir, { answers: [JSON.stringify(DRAFT), JSON.stringify(better)] });
    const before = w.ado.requests().length;
    const first = await w.abe.json(CardDraftData, 'card', 'draft', 'save', 'a', 'wishlist');

    expect(first).toMatchObject({ exit: 0, doc: { ok: true, data: DRAFT } });
    const again = await w.abe.json(
      CardDraftData,
      'card',
      'draft',
      'save a wishlist',
      `--earlier=${JSON.stringify(DRAFT)}`,
    );

    expect(again.doc).toMatchObject({ ok: true, data: better });
    const [one, two] = oneShotCalls(w.abe.state.dir);

    expect(one?.prompt).toContain('## Their words\n\nsave a wishlist');
    expect(one?.prompt).not.toContain('earlier draft');
    expect(two?.prompt).toContain('## Your earlier draft');
    expect(two?.prompt).toContain('Shoppers lose the products they liked.');
    expect(w.ado.requests().length).toBe(before);
  });

  test('card draft: an answer that is no draft is unreadable-answer; a bad --earlier a usage error', async () => {
    scriptOneShot(w.abe.state.dir, { answers: ['I would rather not.'] });
    const bad = await w.abe.json(CardDraftData, 'card', 'draft', 'x');
    const earlier = await w.abe.json(CardDraftData, 'card', 'draft', 'x', '--earlier', '{}');

    expect(bad.doc).toMatchObject({ ok: false, error: { code: 'unreadable-answer' } });
    expect(earlier).toMatchObject({ exit: 2, doc: { ok: false, error: { code: 'usage' } } });
  });

  const listed = async (id: number, mine = false) => {
    const list = await w.abe.json(CardListData, 'card', 'list', ...(mine ? ['--mine'] : []));

    if (!list.doc.ok) throw new Error(list.doc.error.message);

    return list.doc.data.cards.find((c) => c.id === id);
  };

  test('by default: the board’s first type, New, nobody’s, the current sprint; then in card list', async () => {
    const { exit, doc } = await w.abe.json(
      CardData,
      'card',
      'create',
      '--title',
      'Customers can save a wishlist',
      '--description',
      '## Why\n\nThey lose what they liked.',
      // a value that starts with `-` goes inline
      '--criteria=- [ ] A heart saves the product',
    );

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data).toMatchObject({
      title: 'Customers can save a wishlist',
      type: 'User Story',
      state: 'New',
      assignee: null,
      description: '## Why\n\nThey lose what they liked.',
      acceptanceCriteria: '- [ ] A heart saves the product',
    });
    expect((await listed(doc.data.id))?.title).toBe('Customers can save a wishlist');
    const post = w.ado.requests().find((r) => r.startsWith('POST ') && r.includes('workitems/$'));

    expect(decodeURIComponent(post ?? '')).toContain('workitems/$User Story');
  });

  test('--type --state --assign me: as given, and on your Mine', async () => {
    const { doc } = await w.abe.json(
      CardData,
      'card',
      'create',
      '--title',
      'The cart total ignores quantity',
      '--type',
      'Bug',
      '--state',
      'Active',
      '--assign',
      'me',
      '--sprint',
      'none',
    );

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data).toMatchObject({
      type: 'Bug',
      state: 'Active',
      assignee: { name: 'Alex Example' },
    });
    expect((await listed(doc.data.id, true))?.id).toBe(doc.data.id);
  });

  test('a state the type has not: rejected, naming its states; a type the board has not too', async () => {
    const before = w.ado.requests().length;
    const state = await w.abe.json(
      CardData,
      'card',
      'create',
      '--title',
      'x',
      '--type',
      'Bug',
      '--state',
      'Ready',
    );

    expect(state.exit).toBe(1);
    expect(state.doc).toMatchObject({
      ok: false,
      error: {
        code: 'rejected',
        message: "'Ready' is not a state of a Bug: New, Active, Resolved, Closed, Removed",
      },
    });
    const type = await w.abe.json(CardData, 'card', 'create', '--title', 'x', '--type', 'Task');

    expect(type.doc).toMatchObject({
      ok: false,
      error: { code: 'rejected', message: "'Task' is not a type of this board: User Story, Bug" },
    });
    // the type is checked before anything is sent
    expect(w.ado.requests().filter((r) => r.startsWith('POST ')).length).toBe(
      w.ado
        .requests()
        .slice(0, before)
        .filter((r) => r.startsWith('POST ')).length + 1,
    );
  });

  test('no title, or a field given both ways: a usage error, nothing sent', async () => {
    writeFileSync(join(w.repo, 'd.md'), 'Why\n');
    const before = w.ado.requests().length;
    const blank = await w.abe.json(CardData, 'card', 'create', '--title', '  ');
    const both = await w.abe.json(
      CardData,
      'card',
      'create',
      '--title',
      'x',
      '--description',
      'a',
      '--description-file',
      'd.md',
    );

    expect(blank).toMatchObject({ exit: 2, doc: { ok: false, error: { code: 'usage' } } });
    expect(both).toMatchObject({ exit: 2, doc: { ok: false, error: { code: 'usage' } } });
    expect(w.ado.requests().length).toBe(before);
  });

  test('--description-file: the file’s markdown', async () => {
    writeFileSync(join(w.repo, 'why.md'), '## Why\n\nFrom a file.\n');
    const { doc } = await w.abe.json(
      CardData,
      'card',
      'create',
      '--title',
      'From a file',
      '--description-file',
      'why.md',
    );

    expect(doc).toMatchObject({ ok: true, data: { description: '## Why\n\nFrom a file.' } });
  });

  test('card list names the board’s types, the first a New card’s', async () => {
    const list = await w.abe.json(CardListData, 'card', 'list');

    expect(list.doc).toMatchObject({ ok: true, data: { board: { types: ['User Story', 'Bug'] } } });
  });
});

describe('card list --closed on a board with no current sprint (#239)', () => {
  test('the done cards of the last days, Removed never', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-nosprint-'));
    const seed = z
      .looseObject({
        sprints: z.array(z.looseObject({ name: z.string() })),
        items: z.array(z.looseObject({ id: z.number(), state: z.string() })),
      })
      .parse(JSON.parse(readFileSync(ADO_SEED, 'utf8')));
    const file = join(dir, 'seed.json');

    writeFileSync(
      file,
      JSON.stringify({
        ...seed,
        sprints: seed.sprints.map(({ name }) => ({ name })),
        // 5 removed: gone from every list
        items: seed.items.map((it) => (it.id === 5 ? { ...it, state: 'Removed' } : it)),
      }),
    );
    const w = await world({ tokens: ['token-one'], seed: file });

    try {
      const { doc } = await w.abe.json(CardListData, 'card', 'list', '--closed');

      if (!doc.ok) throw new Error(doc.error.message);
      expect(doc.data.sprint).toBeNull();
      // 9 was closed within the last 14 days (the seed's cards changed 14 days ago)
      expect(ids(doc.data.cards)).toEqual([4, 6, 7, 8, 9, 13]);
    } finally {
      await w.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the token', () => {
  test('a 401 renews it once from az, and the command goes through', async () => {
    const w = await world({ tokens: ['stale', 'fresh'], expired: ['stale'] });

    try {
      const { exit, doc } = await w.abe.json(CardShowData, 'card', 'show', '4');

      expect(exit).toBe(0);
      expect(doc).toMatchObject({ ok: true, data: { id: 4 } });
      expect(w.az.calls()).toEqual([AZ_ARGV, AZ_ARGV]);
      const card = w.ado
        .requests()
        .filter((r) => r.startsWith('GET /demo-org/Sandbox/_apis/wit/workitems/4?'));

      expect(card.map((r) => / → (\d+)/.exec(r)?.[1])).toEqual(['401', '200']);
      // The renewed token is kept.
      await w.abe.json(CardShowData, 'card', 'show', '5');
      expect(w.az.calls().length).toBe(2);
    } finally {
      await w.close();
    }
  });

  test('refused again after the renewal: auth, and az is asked no third time', async () => {
    const w = await world({ tokens: ['old', 'older'], expired: ['old', 'older'] });

    try {
      const { exit, doc } = await w.abe.json(CardShowData, 'card', 'show', '4');

      expect(exit).toBe(1);
      expect(doc).toMatchObject({ ok: false, error: { code: 'auth' } });
      if (!doc.ok) expect(doc.error.message).toContain('az login --allow-no-subscriptions');
      expect(w.az.calls().length).toBe(2);
    } finally {
      await w.close();
    }
  });

  test('no az login: auth, saying how to log in, and no request made', async () => {
    const w = await world({ tokens: [] });

    try {
      const { exit, doc } = await w.abe.json(CardListData, 'card', 'list');

      expect(exit).toBe(1);
      expect(doc).toMatchObject({ ok: false, error: { code: 'auth' } });
      if (!doc.ok) expect(doc.error.message).toContain('az login --allow-no-subscriptions');
      expect(w.ado.requests()).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe('the board setting', () => {
  test('none: no-board, naming what to set', async () => {
    const w = await world({ tokens: ['t'], board: { columns: ['New', 'Active'] } });

    try {
      const { exit, doc } = await w.abe.json(CardListData, 'card', 'list');

      expect(exit).toBe(1);
      expect(doc).toMatchObject({ ok: false, error: { code: 'no-board' } });
      expect(w.az.calls()).toEqual([]);
    } finally {
      await w.close();
    }
  });

  test('excludeLanes and notTag: card list leaves out the lane’s cards and the tagged ones; each card its lane', async () => {
    const w = await world({
      tokens: ['t'],
      board: {
        organization: 'https://dev.azure.com/demo-org',
        project: 'Sandbox',
        team: 'Sandbox',
        excludeLanes: ['External dependencies'],
        notTag: 'checkout',
      },
    });

    try {
      const { exit, doc } = await w.abe.json(CardListData, 'card', 'list');

      expect(exit).toBe(0);
      if (!doc.ok) throw new Error(doc.error.message);
      // 7 waits in External dependencies, 13 carries checkout; 8 in Expedite and those in no lane stay
      expect(ids(doc.data.cards)).toEqual([4, 5, 6, 8]);
      expect(doc.data.cards.map((c) => c.lane ?? null)).toEqual([null, null, null, 'Expedite']);
    } finally {
      await w.close();
    }
  });

  test('an organization that is not Azure DevOps: bad-board, and no token is asked for', async () => {
    const w = await world({
      tokens: ['t'],
      board: { organization: 'https://example.test/demo-org', project: 'Sandbox', team: 'Sandbox' },
    });

    try {
      const { exit, doc } = await w.abe.json(CardShowData, 'card', 'show', '4');

      expect(exit).toBe(1);
      expect(doc).toMatchObject({ ok: false, error: { code: 'bad-board' } });
      expect(w.az.calls()).toEqual([]);
    } finally {
      await w.close();
    }
  });

  test('provider local: a board On this Mac, its cards kept in the state folder, no token asked for', async () => {
    const files = boardLayers({ provider: 'local', project: 'demo' });
    const state = tempState();
    const abe = await macServed({ ...files.env }, { state, cwd: files.repo });

    try {
      const made = await abe.json(CardData, 'card', 'create', '--title', 'First', '--assign', 'me');

      expect(made.doc).toMatchObject({
        ok: true,
        data: { id: 1, title: 'First', state: 'New', type: 'User Story', url: 'local:demo#1' },
      });
      const moved = await abe.json(CardData, 'card', 'move', '1', 'Active');
      const wrong = await abe.json(CardData, 'card', 'move', '1', 'Doing');
      const commented = await abe.json(CardCommentData, 'card', 'comment', '1', '--text', 'Hello');
      const shown = await abe.json(CardShowData, 'card', 'show', '1');
      const listed = await abe.json(CardListData, 'card', 'list');

      expect(moved.doc).toMatchObject({ ok: true, data: { id: 1, state: 'Active' } });
      expect(wrong.doc).toMatchObject({ ok: false, error: { code: 'rejected' } });
      expect(commented.doc).toMatchObject({ ok: true, data: { card: 1, id: 1, text: 'Hello' } });
      expect(shown.doc).toMatchObject({
        ok: true,
        data: { id: 1, state: 'Active', comments: [{ text: 'Hello' }] },
      });
      expect(listed.doc).toMatchObject({
        ok: true,
        data: {
          board: { provider: 'local', organization: 'this machine', project: 'demo' },
          cards: [{ id: 1 }],
        },
      });
      // no box reaches it: agents run here only
      const cloud = await abe.json(FactoryRunData, 'factory', 'run', '1', '--target', 'cloud');

      expect(cloud.doc).toMatchObject({ ok: false, error: { code: 'local-board' } });
      expect(readFileSync(join(state.dir, 'local', 'board', 'demo.json'), 'utf8')).toContain(
        '"title": "First"',
      );
    } finally {
      await abe.close();
      files.remove();
    }
  });

  test('provider github: the issues of the repo origin names, as the gh login; no az token asked for', async () => {
    const files = boardLayers({ provider: 'github' });
    const gh = fakeGh([
      ['api user', { json: ghUser('ada') }],
      ['-X PATCH', { json: ghIssue('acme/shop', 3, { labels: ['active'] }) }],
      ['issues/3', { json: ghIssue('acme/shop', 3) }],
      [
        'state=open',
        {
          json: [
            ghIssue('acme/shop', 3, { title: 'Show stock', assignees: ['ada'] }),
            ghIssue('acme/shop', 4, { pull: true }),
          ],
        },
      ],
    ]);

    Bun.spawnSync([
      'git',
      '-C',
      files.repo,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/shop.git',
    ]);
    const abe = await macServed({ ...files.env, PATH: gh.path }, { cwd: files.repo });

    try {
      const listed = await abe.json(CardListData, 'card', 'list', '--mine');
      const moved = await abe.json(CardData, 'card', 'move', '#3', 'Active');
      const text = await abe.run('card', 'list');

      expect(listed.doc).toMatchObject({
        ok: true,
        data: {
          board: {
            provider: 'github',
            organization: 'https://github.com/acme',
            project: 'acme/shop',
          },
          mine: true,
          cards: [{ id: 3, title: 'Show stock', assignee: { name: 'ada' } }],
        },
      });
      expect(moved.doc).toMatchObject({ ok: true, data: { id: 3, state: 'Active' } });
      expect(text.stdout).toContain('#3        New  Show stock');
      expect(gh.calls().map((c) => c.argv.slice(0, 4).join(' '))).toContain(
        'api -X PATCH repos/acme/shop/issues/3',
      );
    } finally {
      await abe.close();
      gh.remove();
      files.remove();
    }
  });

  test('a team the project does not have: not-found', async () => {
    const w = await world({
      tokens: ['t'],
      board: { organization: 'https://dev.azure.com/demo-org', project: 'Sandbox', team: 'Nobody' },
    });

    try {
      const { doc } = await w.abe.json(CardListData, 'card', 'list');

      expect(doc).toMatchObject({ ok: false, error: { code: 'not-found' } });
    } finally {
      await w.close();
    }
  });
});
