/** The Tracking adapter's reads and writes the pr stage adds (#48), against the fake `gh`. */
import { afterEach, describe, expect, test } from 'bun:test';
import { Repo } from '@abe/core';
import {
  fakeGh,
  type FakeGh,
  ghIssueComment,
  ghListedPull,
  ghPrView,
  ghPull,
  ghReview,
  ghUser,
} from '@abe/testing';
import { boxTracking, ghTrackingFrom } from './tracking';

const REPO = Repo.parse('acme/demo');

describe('Tracking: a pull request by its branch, and issue comments', () => {
  let gh: FakeGh | undefined;
  const start = (answers: Parameters<typeof fakeGh>[0]) => {
    gh = fakeGh(answers);

    return { gh, tracking: ghTrackingFrom({ PATH: gh.path }) };
  };

  afterEach(() => {
    gh?.remove();
  });

  test('prFind: the open pull request on the head, read in full', async () => {
    const { gh, tracking } = start([
      ['head=acme:card/4-sign-in', { json: [ghPull('acme/demo', 41)] }],
      ['pr view 41 -R', { json: ghPrView('acme/demo', 41, { head: 'card/4-sign-in' }) }],
    ]);
    const found = await tracking.prFind({ repo: REPO, head: 'card/4-sign-in' });

    expect(found.ok && found.data?.number).toBe(41);
    expect(gh.calls()[0]?.argv).toEqual([
      'api',
      '-X',
      'GET',
      'repos/acme/demo/pulls',
      '-f',
      'head=acme:card/4-sign-in',
      '-f',
      'state=open',
      '-f',
      'per_page=1',
    ]);
  });

  test('prFind: none open on the head is null', async () => {
    const { tracking } = start([['head=acme:card/5', { json: [] }]]);

    expect(await tracking.prFind({ repo: REPO, head: 'card/5' })).toEqual({ ok: true, data: null });
  });

  test('issueComment: markdown on an issue or pull request, its link back', async () => {
    const { gh, tracking } = start([
      [
        'repos/acme/demo/issues/41/comments',
        { json: ghIssueComment('acme/demo', 41, 77, 'Deployed.') },
      ],
    ]);

    expect(await tracking.issueComment({ repo: REPO, number: 41 }, 'Deployed.')).toEqual({
      ok: true,
      data: {
        repo: 'acme/demo',
        number: 41,
        id: 77,
        url: 'https://github.com/acme/demo/issues/41#issuecomment-77',
      },
    });
    const [call] = gh.calls();

    expect(call?.argv).toEqual([
      'api',
      '-X',
      'POST',
      'repos/acme/demo/issues/41/comments',
      '--input',
      '-',
    ]);
    expect(JSON.parse(call?.stdin ?? '')).toEqual({ body: 'Deployed.' });
  });

  test.each<
    [
      string,
      { stdout?: string; stderr?: string; exit?: number },
      { deleted: boolean; error: string | null },
    ]
  >([
    ['deleted', { stdout: '' }, { deleted: true, error: null }],
    [
      'GitHub deleted it already',
      { stderr: 'gh: Reference does not exist (HTTP 422)', exit: 1 },
      { deleted: true, error: null },
    ],
    [
      'refused: the merge stands, the branch stays',
      { stderr: 'gh: Resource not accessible by integration (HTTP 403)', exit: 1 },
      { deleted: false, error: 'gh: Resource not accessible by integration (HTTP 403)' },
    ],
  ])('prMerge with deleteBranch: merged, then the head branch %s', async (_, del, branch) => {
    const { gh, tracking } = start([
      ['pulls/41/merge', { json: { sha: 'm3rg3', merged: true, message: 'merged' } }],
      ['-X DELETE', del],
    ]);
    const merged = await tracking.prMerge(
      { repo: REPO, number: 41 },
      { method: 'squash', sha: 'h3ad', deleteBranch: 'card/4-sign-in' },
    );

    expect(merged).toEqual({
      ok: true,
      data: {
        repo: 'acme/demo',
        number: 41,
        sha: 'm3rg3',
        merged: true,
        branch: { name: 'card/4-sign-in', ...branch },
      },
    });
    expect(gh.calls().at(-1)?.argv).toEqual([
      'api',
      '-X',
      'DELETE',
      'repos/acme/demo/git/refs/heads/card/4-sign-in',
    ]);
  });
});

describe("Linked's reads: a pull request's reviews", () => {
  let gh: FakeGh | undefined;
  const start = (answers: Parameters<typeof fakeGh>[0]) => {
    gh = fakeGh(answers);

    return { gh, tracking: ghTrackingFrom({ PATH: gh.path }) };
  };

  afterEach(() => {
    gh?.remove();
  });

  test('prReviews: the submitted ones, by whom and how, pending ones left out', async () => {
    const { gh, tracking } = start([
      [
        'repos/acme/demo/pulls/10/reviews',
        {
          json: [
            ghReview(1, 'sam', 'COMMENTED'),
            ghReview(2, 'sam', 'APPROVED'),
            ghReview(3, 'kim', 'PENDING'),
          ],
        },
      ],
    ]);

    expect(await tracking.prReviews({ repo: REPO, number: 10 })).toEqual({
      ok: true,
      data: [
        { by: 'sam', state: 'COMMENTED' },
        { by: 'sam', state: 'APPROVED' },
      ],
    });
    expect(gh.calls()[0]?.argv).toEqual(['api', 'repos/acme/demo/pulls/10/reviews?per_page=100']);
  });
});

describe("on a box you are its owner: me() is $ABE_OWNER, never gh's", () => {
  let gh: FakeGh | undefined;
  const start = (env: Record<string, string>) => {
    gh = fakeGh([
      ['api user', { json: ghUser('octocat') }],
      ['pr view 41 -R', { json: ghPrView('acme/demo', 41) }],
    ]);

    return { gh, tracking: boxTracking(env, ghTrackingFrom({ PATH: gh.path })) };
  };

  afterEach(() => {
    gh?.remove();
  });

  test('ABE_BOX and ABE_OWNER: the owner, and no gh call', async () => {
    const { gh, tracking } = start({ ABE_BOX: '1', ABE_OWNER: 'ada' });

    expect(await tracking.me()).toEqual({ ok: true, data: { login: 'ada' } });
    expect(gh.calls()).toEqual([]);
  });

  test('the rest is still gh', async () => {
    const { gh, tracking } = start({ ABE_BOX: '1', ABE_OWNER: 'ada' });
    const shown = await tracking.prShow({ repo: REPO, number: 41 });

    expect(shown.ok && shown.data.number).toBe(41);
    // The pull request, then its head's workflow runs and commit statuses.
    expect(gh.calls()).toHaveLength(3);
  });

  test.each([
    ['unset', {}],
    ['empty', { ABE_OWNER: '' }],
  ])('a box with ABE_OWNER %s: refused, naming ABE_OWNER, and no gh call', async (_, owner) => {
    const { gh, tracking } = start({ ABE_BOX: '1', ...owner });

    expect(await tracking.me()).toEqual({
      ok: false,
      error: {
        code: 'auth',
        message: 'this box was not told whose it is (ABE_OWNER, from its abe:owner tag)',
      },
    });
    expect(gh.calls()).toEqual([]);
  });

  test("off a box: gh's login, ABE_OWNER or not", async () => {
    const { gh, tracking } = start({ ABE_OWNER: 'ada' });

    expect(await tracking.me()).toEqual({ ok: true, data: { login: 'octocat' } });
    expect(gh.calls()).toHaveLength(1);
  });
});

describe('fresh looks (#236): the pull requests and runs changed last', () => {
  let gh: FakeGh | undefined;

  afterEach(() => {
    gh?.remove();
  });

  test('recentPrs: any state, the last changed first, merged said as merged', async () => {
    gh = fakeGh([
      [
        'pulls?state=all&sort=updated&direction=desc&per_page=30',
        {
          json: [
            ghListedPull('acme/demo', 42, { title: 'Cart', updatedAt: '2026-10-25T10:00:00Z' }),
            ghListedPull('acme/demo', 41, {
              state: 'closed',
              mergedAt: '2026-10-25T09:00:00Z',
              branch: 'card/4-sign-in',
              updatedAt: '2026-10-25T09:00:00Z',
            }),
          ],
        },
      ],
    ]);
    const tracking = ghTrackingFrom({ PATH: gh.path });

    expect(await tracking.recentPrs(REPO)).toEqual({
      ok: true,
      data: [
        {
          number: 42,
          title: 'Cart',
          state: 'open',
          branch: 'card/42',
          updatedAt: '2026-10-25T10:00:00Z',
        },
        {
          number: 41,
          title: 'Change 41',
          state: 'merged',
          branch: 'card/4-sign-in',
          updatedAt: '2026-10-25T09:00:00Z',
        },
      ],
    });
    expect(gh.calls()[0]?.argv).toEqual([
      'api',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=30',
    ]);
  });
});
