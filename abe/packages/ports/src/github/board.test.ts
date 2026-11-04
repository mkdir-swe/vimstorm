/**
 * The Board on a repo's GitHub Issues against the fake `gh`: issues as cards (never pull
 * requests), yours by the gh login, the done ones of the last days, each write as GitHub's own
 * (a state, labels, assignees, a comment, a new issue under its parent), and what GitHub has
 * nothing like refused by name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type BoardRef, boardOf, type CardData } from '@abe/core';
import { fakeGh, type FakeGh, type GhAnswer, ghIssue, ghIssueComment, ghUser } from '@abe/testing';
import { githubBoard } from './board';
import { ghRunner } from './gh';

const REPO = 'acme/shop';
const ISSUES = `repos/${REPO}/issues`;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const ME = 'ada';

const boardWith = (more: Record<string, unknown> = {}): BoardRef => {
  const b = boardOf({ provider: 'github', repo: REPO, ...more });

  if (!b.ok) throw new Error(b.error.message);

  return b.board;
};
const BOARD = boardWith();

let gh: FakeGh | undefined;
const start = (answers: readonly (readonly [string, GhAnswer])[]) => {
  gh = fakeGh([['api user', { json: ghUser(ME) }], ...answers]);
  const runner = ghRunner({ PATH: gh.path });

  return { gh, board: githubBoard({ ghAs: () => runner, now: () => NOW }) };
};
const argvs = (f: FakeGh) => f.calls().map((c) => c.argv.join(' '));
const sent = (f: FakeGh, method: string): unknown[] =>
  f
    .calls()
    .filter((c) => c.argv.includes(method))
    .map((c): unknown => JSON.parse(c.stdin));

afterEach(() => {
  gh?.remove();
});

const card = (over: Partial<CardData> & Pick<CardData, 'id'>): CardData => ({
  title: `Issue ${over.id}`,
  state: 'New',
  type: 'Issue',
  tags: [],
  assignee: null,
  description: `Body of ${over.id}.`,
  acceptanceCriteria: '',
  url: `https://github.com/${REPO}/issues/${over.id}`,
  points: null,
  createdBy: { name: 'octocat', email: 'octocat' },
  ...over,
});

describe('list: the open issues as cards, newest change first', () => {
  const open = [
    ghIssue(REPO, 3, {
      labels: ['active', 'web'],
      assignees: [ME],
      updatedAt: '2026-11-03T00:00:00Z',
      body: 'Why.\n\n## Acceptance criteria\n\n- [ ] Done.',
    }),
    ghIssue(REPO, 4, { pull: true }),
    ghIssue(REPO, 2, { labels: ['bug'], updatedAt: '2026-11-02T00:00:00Z' }),
  ];

  test('issues only, their column from a label, a Bug from bug, the criteria split off', async () => {
    const { gh, board } = start([['state=open', { json: open }]]);

    expect(await board.list(BOARD, { mine: false })).toEqual({
      ok: true,
      data: [
        card({
          id: 3,
          state: 'Active',
          tags: ['web'],
          assignee: { name: ME, email: ME },
          description: 'Why.',
          acceptanceCriteria: '- [ ] Done.',
        }),
        card({ id: 2, type: 'Bug', tags: ['bug'] }),
      ],
    });
    expect(argvs(gh)).toEqual([
      `api ${ISSUES}?state=open&sort=updated&direction=desc&per_page=100&page=1`,
    ]);
  });

  test('mine: assigned to the gh login', async () => {
    const { gh, board } = start([['state=open', { json: [open[0]] }]]);
    const mine = await board.list(BOARD, { mine: true });

    expect(mine.ok && mine.data.map((c) => c.id)).toEqual([3]);
    expect(argvs(gh)).toEqual([
      'api user',
      `api ${ISSUES}?state=open&sort=updated&direction=desc&assignee=${ME}&per_page=100&page=1`,
    ]);
  });

  test("the board's types, its tag and the tag it leaves out are labels", async () => {
    const { board } = start([['state=open', { json: open }]]);
    const ids = async (b: BoardRef) => {
      const l = await board.list(b, { mine: false });

      return l.ok ? l.data.map((c) => c.id) : l.error.code;
    };

    expect(await ids(boardWith({ types: ['Bug'] }))).toEqual([2]);
    expect(await ids(boardWith({ tag: 'WEB' }))).toEqual([3]);
    expect(await ids(boardWith({ notTag: 'web' }))).toEqual([2]);
  });

  test('--closed: the issues closed as completed in the last days too; no sprint', async () => {
    const { gh, board } = start([
      ['state=open', { json: [] }],
      [
        'state=closed',
        {
          json: [
            ghIssue(REPO, 7, {
              state: 'closed',
              stateReason: 'completed',
              closedAt: '2026-11-01T00:00:00Z',
            }),
            ghIssue(REPO, 8, {
              state: 'closed',
              stateReason: 'not_planned',
              closedAt: '2026-11-01T00:00:00Z',
            }),
            ghIssue(REPO, 9, {
              state: 'closed',
              stateReason: 'completed',
              closedAt: '2026-10-01T00:00:00Z',
            }),
          ],
        },
      ],
    ]);
    const l = await board.list(BOARD, { mine: false, done: { days: 14 } });

    expect(l.ok && l.data.map((c) => [c.id, c.state])).toEqual([[7, 'Closed']]);
    expect(argvs(gh)[1]).toContain('state=closed&since=2026-10-21T12:00:00.000Z');
    expect(await board.currentSprint(BOARD)).toEqual({ ok: true, data: null });
    expect(await board.list(BOARD, { mine: false, iteration: 'Sprint 1' })).toEqual({
      ok: true,
      data: [],
    });
  });

  test("gh's refusals as the Board's codes", async () => {
    const { board } = start([
      ['state=open', { stderr: 'gh: Not Found (HTTP 404)', exit: 1 }],
      ['issues/5', { stderr: 'HTTP 401: Bad credentials', exit: 1 }],
    ]);
    const list = await board.list(BOARD, { mine: false });
    const show = await board.show(BOARD, 5);

    expect(!list.ok && list.error.code).toBe('not-found');
    expect(!show.ok && show.error.code).toBe('auth');
  });
});

describe('show: the issue and its comments; a pull request is no card', () => {
  test('its comments, oldest first', async () => {
    const { board } = start([
      [`${ISSUES}/5/comments`, { json: [ghIssueComment(REPO, 5, 70, 'Looks right.')] }],
      [`${ISSUES}/5`, { json: ghIssue(REPO, 5) }],
      [`${ISSUES}/6`, { json: ghIssue(REPO, 6, { pull: true }) }],
    ]);

    expect(await board.show(BOARD, 5)).toEqual({
      ok: true,
      data: {
        ...card({ id: 5 }),
        comments: [{ id: 70, text: 'Looks right.', by: 'octocat', at: '2026-10-23T09:00:00Z' }],
      },
    });
    const pull = await board.show(BOARD, 6);

    expect(!pull.ok && pull.error).toEqual({
      code: 'not-found',
      message: `#6 is a pull request on ${REPO}, not an issue`,
    });
  });
});

describe('writes: as GitHub has them', () => {
  test('move: the column label and the state; a state GitHub has nothing like is refused unsent', async () => {
    const { gh, board } = start([
      ['-X PATCH', { json: ghIssue(REPO, 5, { labels: ['web', 'active'] }) }],
      [`${ISSUES}/5`, { json: ghIssue(REPO, 5, { labels: ['web', 'resolved'] }) }],
    ]);
    const moved = await board.move(BOARD, 5, 'Active');

    expect(moved.ok && moved.data.state).toBe('Active');
    expect(sent(gh, 'PATCH')).toEqual([{ state: 'open', labels: ['web', 'active'] }]);
    const before = gh.calls().length;
    const bad = await board.move(BOARD, 5, 'In Review');

    expect(!bad.ok && bad.error.code).toBe('rejected');
    expect(!bad.ok && bad.error.message).toContain('New, Active, Resolved, Closed, Removed');
    expect(gh.calls().length).toBe(before);
  });

  test('move to Closed and Removed: closed as completed, as not planned', async () => {
    const { gh, board } = start([
      ['-X PATCH', { json: ghIssue(REPO, 5, { state: 'closed', stateReason: 'completed' }) }],
      [`${ISSUES}/5`, { json: ghIssue(REPO, 5, { labels: ['active'] }) }],
    ]);

    await board.move(BOARD, 5, 'Closed');
    await board.move(BOARD, 5, 'Removed');
    expect(sent(gh, 'PATCH')).toEqual([
      { state: 'closed', state_reason: 'completed', labels: [] },
      { state: 'closed', state_reason: 'not_planned', labels: [] },
    ]);
  });

  test('assign: to you by the gh login, to no one; one GitHub leaves out is refused', async () => {
    const { gh, board } = start([
      ['-X PATCH', { json: ghIssue(REPO, 5, { assignees: [ME] }) }],
      [`${ISSUES}/5`, { json: ghIssue(REPO, 5) }],
    ]);
    const mine = await board.assign(BOARD, 5, { kind: 'me' });

    expect(mine.ok && mine.data.assignee).toEqual({ name: ME, email: ME });
    await board.assign(BOARD, 5, { kind: 'none' });
    const them = await board.assign(BOARD, 5, { kind: 'member', login: 'octocat' });

    expect(sent(gh, 'PATCH')).toEqual([
      { assignees: [ME] },
      { assignees: [] },
      { assignees: ['octocat'] },
    ]);
    expect(!them.ok && them.error.code).toBe('rejected');
    expect(!them.ok && them.error.message).toContain('did not assign #5 to octocat');
  });

  test('tag: labels on and off, the column ones kept; a column label is refused', async () => {
    const { gh, board } = start([
      ['-X PATCH', { json: ghIssue(REPO, 5, { labels: ['active', 'web', 'prototype'] }) }],
      [`${ISSUES}/5`, { json: ghIssue(REPO, 5, { labels: ['active', 'web', 'old'] }) }],
    ]);
    const tagged = await board.tag(BOARD, 5, { add: ['prototype'], remove: ['old'] });

    expect(tagged.ok && tagged.data.tags).toEqual(['web', 'prototype']);
    expect(sent(gh, 'PATCH')).toEqual([{ labels: ['active', 'web', 'prototype'] }]);
    const column = await board.tag(BOARD, 5, { add: ['resolved'], remove: [] });

    expect(!column.ok && column.error.code).toBe('rejected');
  });

  test('comment, write: a new comment; the title and long fields as one body', async () => {
    const { gh, board } = start([
      ['-X POST', { json: ghIssueComment(REPO, 5, 71, 'On it.') }],
      ['-X PATCH', { json: ghIssue(REPO, 5, { title: 'New title' }) }],
      [
        `${ISSUES}/5`,
        { json: ghIssue(REPO, 5, { body: 'Was.\n\n## Acceptance criteria\n\n- [ ] Kept.' }) },
      ],
    ]);

    expect(await board.comment(BOARD, 5, 'On it.')).toEqual({
      ok: true,
      data: { card: 5, id: 71, text: 'On it.', by: 'octocat', at: '2026-10-23T09:00:00Z' },
    });
    await board.write(BOARD, 5, { title: 'New title', description: 'Now.' });
    expect(sent(gh, 'POST')).toEqual([{ body: 'On it.' }]);
    expect(sent(gh, 'PATCH')).toEqual([
      { title: 'New title', body: 'Now.\n\n## Acceptance criteria\n\n- [ ] Kept.\n' },
    ]);
  });

  test('create: an issue with its labels, assigned to you, then made a sub-issue of its parent', async () => {
    const made = ghIssue(REPO, 12, { labels: ['bug', 'active'], assignees: [ME] });
    const { gh, board } = start([
      ['/sub_issues', { json: {} }],
      ['-X POST', { json: made }],
    ]);
    const c = await board.create(BOARD, {
      title: 'Fix the total',
      description: 'It is off.',
      acceptanceCriteria: '- [ ] Right.',
      type: 'Bug',
      state: 'Active',
      assignee: 'me',
      tags: ['web'],
      parent: 4,
    });

    expect(c.ok && [c.data.id, c.data.type, c.data.state]).toEqual([12, 'Bug', 'Active']);
    expect(argvs(gh).filter((a) => a.includes('POST'))).toEqual([
      `api -X POST ${ISSUES} --input -`,
      `api -X POST ${ISSUES}/4/sub_issues --input -`,
    ]);
    expect(sent(gh, 'POST')).toEqual([
      {
        title: 'Fix the total',
        body: 'It is off.\n\n## Acceptance criteria\n\n- [ ] Right.\n',
        labels: ['web', 'bug', 'active'],
        assignees: [ME],
      },
      { sub_issue_id: made.id },
    ]);
    const wrong = await board.create(BOARD, {
      title: 'x',
      description: '',
      acceptanceCriteria: '',
      type: 'User Story',
    });

    expect(!wrong.ok && wrong.error.code).toBe('rejected');
  });

  test('members: who can be assigned, you marked', async () => {
    const { board } = start([
      [`repos/${REPO}/assignees`, { json: [ghUser('octocat'), ghUser(ME)] }],
    ]);

    expect(await board.members(BOARD)).toEqual({
      ok: true,
      data: [
        { name: 'octocat', email: 'octocat', you: false },
        { name: ME, email: ME, you: true },
      ],
    });
    expect(await board.me(BOARD)).toEqual({ ok: true, data: { name: ME, email: ME } });
  });

  test('images and attachments: GitHub has no API for them, refused by name', async () => {
    const { gh, board } = start([]);
    const image = await board.image(BOARD, 'https://github.com/user-attachments/assets/x');
    const attach = await board.attach(BOARD, 5, { name: 'a.png', bytes: new Uint8Array() });

    expect([!image.ok && image.error.code, !attach.ok && attach.error.code]).toEqual([
      'unsupported',
      'unsupported',
    ]);
    expect(gh.calls()).toEqual([]);
  });
});

describe('changes: the issues changed since the last look', () => {
  test('none looked yet: where the next starts, nothing read', async () => {
    const { gh, board } = start([]);

    expect(await board.changes(BOARD, null)).toEqual({
      ok: true,
      data: { at: '2026-11-04T12:00:00.000Z', cards: [], gone: [] },
    });
    expect(gh.calls()).toEqual([]);
  });

  test('the changed ones on the board, yours marked; the ones gone from it; the next look after the last', async () => {
    const { gh, board } = start([
      [
        'state=all',
        {
          json: [
            ghIssue(REPO, 3, { assignees: [ME], updatedAt: '2026-11-04T10:00:00Z' }),
            ghIssue(REPO, 4, {
              state: 'closed',
              stateReason: 'not_planned',
              updatedAt: '2026-11-04T10:30:00Z',
            }),
            ghIssue(REPO, 5, { pull: true, updatedAt: '2026-11-04T11:00:00Z' }),
          ],
        },
      ],
    ]);
    const c = await board.changes(BOARD, '2026-11-04T09:00:00Z');

    expect(c).toEqual({
      ok: true,
      data: {
        at: '2026-11-04T10:30:01.000Z',
        cards: [
          {
            card: card({ id: 3, assignee: { name: ME, email: ME } }),
            mine: true,
          },
        ],
        gone: [4],
      },
    });
    expect(argvs(gh)[0]).toBe(
      `api ${ISSUES}?state=all&since=2026-11-04T09:00:00Z&sort=updated&direction=asc&per_page=100&page=1`,
    );
  });
});
