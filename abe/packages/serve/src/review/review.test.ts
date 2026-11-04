/**
 * `abe review …` and Create Draft PR through the CLI seam: a real `serve` over the in-memory
 * review port (1.x's `crates/abe-core/tests/changes_pane.rs` flows): a draft kept on a line of the
 * PR's diff, one review with the drafts on the head read (refused when the PR moved, its drafts
 * kept on a failure, a retry only reconciling), a comment posted now on its own, a reply kept
 * before it goes, marks, the PR's checkout, the PR pick, and a draft PR.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Drafts,
  DraftPrMadeData,
  type Reply,
  ReviewDraftsData,
  ReviewMarksData,
  ReviewOpenData,
  ReviewPrsData,
  ReviewSaidData,
  ReviewShowData,
} from '@abe/core';
import {
  changed,
  fakeReview,
  type FakeReview,
  reviewPr,
  scenario,
  type ServeScenario,
  tempState,
} from '@abe/testing';
import { z } from 'zod';

const MAIN = '/work/shop';
const TREE = '/work/shop-pr-7';
const BASE = 'base000';
const HEAD = 'c0ffee1234';

const sized = (path: string, lines: number) =>
  changed(
    path,
    `@@ -3,${lines} +3,${lines} @@\n${Array.from({ length: lines }, (_, i) => `-a${i}\n+b${i}\n`).join('')}`,
    { additions: lines, deletions: lines },
  );

const doc = <T extends z.ZodType>(schema: T, reply: Reply) =>
  z
    .union([
      z.object({ ok: z.literal(true), data: schema }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ])
    .parse(JSON.parse(reply.stdout));

let s: ServeScenario | undefined;

/**
 * The checkout the review is typed in: TREE, or with a `githubIdentity` a real one, since yours
 * for this repo is read from the checkout's own folder (ADR 0030).
 */
let here = TREE;

/** A state holding a checkout whose yours for this repo says `githubIdentity: <login>`. */
const withIdentity = (login: string) => {
  const state = tempState();
  const checkout = join(state.dir, 'shop-pr-7');

  mkdirSync(join(checkout, '.git'), { recursive: true });
  mkdirSync(join(checkout, '.abe'), { recursive: true });
  writeFileSync(join(checkout, '.abe', 'settings.local.yaml'), `githubIdentity: ${login}\n`);

  return { state, checkout };
};
let review: FakeReview;

afterEach(async () => {
  await s?.close();
  s = undefined;
});

const start = async (more: Partial<FakeReview> = {}, identity?: string) => {
  review = fakeReview({
    main: MAIN,
    base: BASE,
    head: HEAD,
    files: [
      sized('src/big.ts', 9),
      sized('src/small.ts', 1),
      changed('package-lock.json', '@@ -1 +1 @@\n-a\n+b'),
    ],
    github: reviewPr({ head: HEAD }),
    ...more,
  });
  const mine = identity === undefined ? undefined : withIdentity(identity);

  here = mine?.checkout ?? TREE;
  s = await scenario({ review, ...(mine === undefined ? {} : { state: mine.state }) });

  return s;
};

const abe = (...argv: string[]) => {
  if (s === undefined) throw new Error('no scenario');

  return s.request(...argv, '--json');
};

const stored = (): Drafts => review.docs.get(`${MAIN}#7`) ?? { drafts: [] };

/** `,ic` on small.ts:3 of the PR's whole diff. */
const comment = (more: string[] = []) =>
  abe(
    'review',
    'draft',
    '7',
    '--path',
    here,
    '--file',
    'src/small.ts',
    '--side',
    'RIGHT',
    '--line',
    '3',
    '--body',
    'Guard this?',
    '--base',
    BASE,
    '--head',
    HEAD,
    ...more,
  );

describe('abe review show', () => {
  test('the PR, its files read with their hashes and heads, the marks, drafts and discussions', async () => {
    await start({
      packagesIn: ['src'],
      discussions: { code: 'auth', message: 'Review permission denied' },
    });
    const shown = doc(ReviewShowData, await abe('review', 'show', '7', '--path', TREE));

    if (!shown.ok) throw new Error(shown.error.message);
    expect(shown.data).toMatchObject({
      repo: 'acme/shop',
      number: 7,
      path: TREE,
      main: MAIN,
      me: 'ada',
      unchecked: null,
    });
    expect(shown.data.read.files.map((f) => [f.path, f.heads])).toEqual([
      ['src/big.ts', [3]],
      ['src/small.ts', [3]],
      ['package-lock.json', [1]],
    ]);
    expect(shown.data.read.mechanical).toEqual({ 'package-lock.json': 'lockfile' });
    expect(shown.data.read.areas['src/big.ts']).toBe('src');
    expect(shown.data.threads).toBeNull();
    expect(shown.data.threadsError).toBe('Review permission denied');
  });

  test('not checked out: the files from GitHub, on its head', async () => {
    await start();
    const shown = doc(
      ReviewShowData,
      await abe('review', 'show', '7', '--path', MAIN, '--unchecked', 'git said no'),
    );

    expect(shown.ok && [shown.data.unchecked, shown.data.read.base, shown.data.read.head]).toEqual([
      'git said no',
      null,
      HEAD,
    ]);
  });
});

describe('a draft and the review it goes out in', () => {
  test("a comment drafted on the PR's diff, kept numbered on the head read", async () => {
    await start();
    const kept = doc(ReviewDraftsData, await comment());

    expect(kept).toMatchObject({
      ok: true,
      data: { said: '✎ Draft on small.ts:3 · ,is submits 1 draft in one review' },
    });
    expect(stored().drafts).toEqual([
      {
        seq: 1,
        path: 'src/small.ts',
        line: { side: 'RIGHT', line: 3 },
        body: 'Guard this?',
        head: HEAD,
      },
    ]);
  });

  test('a text that starts with a dash is the text, given inline as the screen sends it', async () => {
    await start();
    const kept = doc(
      ReviewDraftsData,
      await abe(
        'review',
        'draft',
        '7',
        `--path=${TREE}`,
        '--file=src/small.ts',
        '--side',
        'RIGHT',
        '--line',
        '3',
        '--body=- nit: rename',
        '--base',
        BASE,
        '--head',
        HEAD,
      ),
    );

    expect(kept.ok).toBe(true);
    expect(stored().drafts.map((d) => d.body)).toEqual(['- nit: rename']);
  });

  test("a comment off the PR's diff, on one commit's, or on a file it does not change is refused", async () => {
    await start();
    const off = await abe(
      'review',
      'draft',
      '7',
      '--path',
      TREE,
      '--file',
      'src/small.ts',
      '--side',
      'RIGHT',
      '--line',
      '40',
      '--body',
      'x',
      '--base',
      BASE,
      '--head',
      HEAD,
    );

    expect(doc(z.unknown(), off)).toEqual({
      ok: false,
      error: {
        code: 'review-refused',
        message:
          "Line 40 of small.ts is not in the PR's diff: GitHub takes comments on its lines only",
      },
    });
    const scoped = await abe(
      'review',
      'draft',
      '7',
      '--path',
      TREE,
      '--file',
      'src/small.ts',
      '--side',
      'RIGHT',
      '--line',
      '3',
      '--body',
      'x',
      '--base',
      'abc^',
      '--head',
      'abc',
    );

    expect(doc(z.unknown(), scoped)).toMatchObject({
      ok: false,
      error: { message: "Comments go on the whole PR's diff: pick All changes in the Log" },
    });
    const elsewhere = await abe(
      'review',
      'draft',
      '7',
      '--path',
      TREE,
      '--file',
      'x.ts',
      '--side',
      'RIGHT',
      '--line',
      '3',
      '--body',
      'x',
      '--base',
      BASE,
      '--head',
      HEAD,
    );

    expect(doc(z.unknown(), elsewhere)).toMatchObject({
      ok: false,
      error: { message: 'x.ts is not in PR #7' },
    });
    expect(review.docs.size).toBe(0);
  });

  test('the approval goes in one review with the draft, on the head read', async () => {
    await start();
    await comment();
    const sent = doc(
      ReviewDraftsData,
      await abe('review', 'submit', '7', '--path', TREE, '--verdict', 'approve', '--read', HEAD),
    );

    expect(sent).toMatchObject({
      ok: true,
      data: { said: '✓ Approve sent to PR #7, 1 comment in one review' },
    });
    const [write] = review.writes;

    expect(write?.kind === 'submit' && write.review.submission).toMatch(/^\d+-[0-9a-f]{14}$/);
    expect(review.writes).toMatchObject([
      {
        kind: 'submit',
        review: {
          reconcileOnly: false,
          pr: 7,
          commit: HEAD,
          verdict: 'Approve',
          comments: [{ path: 'src/small.ts', line: 3, side: 'RIGHT', body: 'Guard this?' }],
        },
      },
    ]);
    expect(stored().submission?.confirmed).toBe(true);
    expect(stored().drafts[0]?.sent).toBe(HEAD);
    expect(stored().review).toBeUndefined();
  });

  test("refused when the PR's head moved; a failed send keeps the drafts waiting", async () => {
    await start();
    await comment();
    review.github = reviewPr({ head: 'feed000000' });
    const moved = await abe(
      'review',
      'submit',
      '7',
      '--path',
      TREE,
      '--verdict',
      'request-changes',
      '--body',
      'Fix the guard',
      '--read',
      HEAD,
    );

    expect(doc(z.unknown(), moved)).toEqual({
      ok: false,
      error: {
        code: 'review-failed',
        message: '✗ Read at c0ffee1, the PR is at feed000: the lines may be off, not sent',
      },
    });
    expect(review.writes).toEqual([]);
    expect(stored().review).toEqual({
      head: HEAD,
      verdict: 'RequestChanges',
      body: 'Fix the guard',
    });
    // GitHub refuses it: the drafts wait again
    review.github = reviewPr({ head: HEAD });
    review.answers.push({ ok: false, error: { code: 'invalid', message: 'HTTP 422' } });
    const refused = await abe(
      'review',
      'submit',
      '7',
      '--path',
      TREE,
      '--verdict',
      'request-changes',
      '--body',
      'Fix the guard',
      '--read',
      HEAD,
    );

    expect(doc(z.unknown(), refused)).toMatchObject({
      ok: false,
      error: { message: '✗ Review submission unconfirmed, drafts kept: HTTP 422' },
    });
    expect(stored().drafts[0]?.sent).toBeUndefined();
    expect(stored().submission?.attempted).toBe(false);
  });

  test('a review whose answer was lost is retried as a reconcile under the same identity', async () => {
    await start();
    await comment();
    review.answers.push({ ok: false, error: { code: 'offline', message: 'Response lost' } });
    await abe(
      'review',
      'submit',
      '7',
      '--path',
      TREE,
      '--verdict',
      'comment',
      '--body',
      'Review summary',
      '--read',
      HEAD,
    );
    const first = review.writes[0];

    expect(stored().review?.body).toBe('Review summary');
    // another verdict waits for it
    const other = await abe(
      'review',
      'submit',
      '7',
      '--path',
      TREE,
      '--verdict',
      'approve',
      '--read',
      HEAD,
    );

    expect(doc(z.unknown(), other)).toMatchObject({ ok: false, error: { code: 'review-refused' } });
    await abe(
      'review',
      'submit',
      '7',
      '--path',
      TREE,
      '--verdict',
      'comment',
      '--body',
      'Review summary',
      '--read',
      HEAD,
    );
    const retry = review.writes[1];

    expect(
      first?.kind === 'submit' &&
        retry?.kind === 'submit' && [retry.review.reconcileOnly, retry.review.submission],
    ).toEqual([true, first?.kind === 'submit' ? first.review.submission : '']);
  });

  test('a comment posted now goes on its own; the pending review and its summary stay', async () => {
    await start();
    await comment();
    review.docs.set(`${MAIN}#7`, {
      ...stored(),
      review: { head: HEAD, verdict: 'Comment', body: 'Pending' },
    });
    const posted = doc(
      ReviewDraftsData,
      await abe(
        'review',
        'draft',
        '7',
        '--path',
        TREE,
        '--file',
        'src/small.ts',
        '--side',
        'RIGHT',
        '--line',
        '3',
        '--body',
        'Post only this now',
        '--base',
        BASE,
        '--head',
        HEAD,
        '--now',
      ),
    );

    expect(posted).toMatchObject({
      ok: true,
      data: { said: 'Comment posted; pending review kept' },
    });
    expect(review.writes).toMatchObject([
      { kind: 'post', body: 'Post only this now', reconcileOnly: false, head: HEAD },
    ]);
    expect(stored().review?.body).toBe('Pending');
    expect(stored().drafts.map((d) => d.sent)).toEqual([undefined, HEAD]);
  });

  test('drop, edit and delete a waiting draft; none while a submission is unconfirmed', async () => {
    await start();
    expect(
      doc(
        z.unknown(),
        await abe('review', 'drop-draft', '7', '--path', TREE, '--file', 'src/big.ts'),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'No draft on this file to drop' },
    });
    await comment();
    expect(
      doc(
        ReviewDraftsData,
        await abe('review', 'edit-draft', '7', '--path', TREE, '--seq', '1', '--body', 'Sharper'),
      ),
    ).toMatchObject({
      ok: true,
      data: { said: '✎ Draft on small.ts:3 edited' },
    });
    expect(
      doc(
        ReviewDraftsData,
        await abe('review', 'drop-draft', '7', '--path', TREE, '--file', 'src/small.ts'),
      ),
    ).toMatchObject({
      ok: true,
      data: { said: 'Draft on small.ts:3 dropped' },
    });
    await comment();
    review.answers.push({ ok: false, error: { code: 'offline', message: 'lost' } });
    await abe('review', 'submit', '7', '--path', TREE, '--verdict', 'comment', '--read', HEAD);
    expect(
      doc(z.unknown(), await abe('review', 'drop-draft', '7', '--path', TREE, '--seq', '1')),
    ).toMatchObject({
      ok: false,
      error: { message: 'Reconcile the unconfirmed submission before changing its comments' },
    });
  });
});

const AS_EVE =
  '✗ GitHub writes go as ada (githubIdentity), but gh is signed in as eve: gh auth switch --user ada';

describe('githubIdentity: the login GitHub writes go as', () => {
  const submit = () =>
    abe('review', 'submit', '7', '--path', here, '--verdict', 'approve', '--read', HEAD);

  test('gh signed in as it: the review goes', async () => {
    await start({}, 'Ada');
    await comment();

    expect(doc(z.unknown(), await submit())).toMatchObject({ ok: true });
    expect(review.writes.map((w) => w.kind)).toEqual(['submit']);
  });

  test('gh signed in as another: refused in red naming both, nothing sent, the draft kept', async () => {
    await start({ login: 'eve' }, 'ada');
    await comment();

    expect(doc(z.unknown(), await submit())).toEqual({
      ok: false,
      error: {
        code: 'review-failed',
        message:
          '✗ GitHub writes go as ada (githubIdentity), but gh is signed in as eve: gh auth switch --user ada',
      },
    });
    expect(review.writes).toEqual([]);
    expect(stored().drafts).toHaveLength(1);
    expect(stored().review).toBeUndefined();
  });

  test("gh's login unread: refused, saying why", async () => {
    await start({ login: null }, 'ada');
    await comment();

    expect(doc(z.unknown(), await submit())).toMatchObject({
      ok: false,
      error: {
        code: 'review-failed',
        message:
          "✗ GitHub writes go as ada (githubIdentity), but gh's login could not be read: gh auth login",
      },
    });
    expect(review.writes).toEqual([]);
  });

  test("unset: gh's login goes, whichever it is", async () => {
    await start({ login: 'eve' });
    await comment();

    expect(doc(z.unknown(), await submit())).toMatchObject({ ok: true });
    expect(review.writes.map((w) => w.kind)).toEqual(['submit']);
  });

  test("a comment on the conversation goes as you, its text intact; an empty one doesn't", async () => {
    await start({ login: 'ada' }, 'ada');

    expect(
      doc(z.unknown(), await abe('review', 'say', '7', '--path', here, '--body', '  ')),
    ).toMatchObject({ ok: false, error: { code: 'review-refused' } });
    expect(
      doc(
        z.unknown(),
        await abe('review', 'say', '7', '--path', here, '--body', 'Fixed in **b2**'),
      ),
    ).toMatchObject({ ok: true, data: { said: 'Comment posted on PR #7' } });
    expect(review.writes).toEqual([{ kind: 'say', body: 'Fixed in **b2**' }]);
  });

  test('every other GitHub write is held to it too; a kept draft is not', async () => {
    await start({ login: 'eve' }, 'ada');
    const kept = doc(z.unknown(), await comment());

    expect(kept).toMatchObject({ ok: true });
    for (const argv of [
      ['review', 'draft', '7', '--path', here, '--file', 'src/small.ts', '--side', 'RIGHT'],
      ['review', 'ready', '7', '--path', here],
      ['review', 'close', '7', '--path', here],
      ['review', 'say', '7', '--path', here, '--body', 'Thanks'],
    ]) {
      const more =
        argv[1] === 'draft'
          ? ['--line', '3', '--body', 'Now', '--base', BASE, '--head', HEAD, '--now']
          : [];

      expect(doc(z.unknown(), await abe(...argv, ...more))).toMatchObject({
        ok: false,
        error: { code: 'review-failed', message: AS_EVE },
      });
    }
    expect(review.writes).toEqual([]);
  });

  test('a reply and a resolve too: refused before the reply is kept', async () => {
    await start(
      {
        login: 'eve',
        discussions: [
          {
            id: 'T1',
            path: 'src/small.ts',
            side: 'LEFT',
            line: 3,
            start: null,
            head: HEAD,
            outdated: false,
            resolved: false,
            canReply: true,
            canResolve: true,
            comments: [{ id: 90, author: 'bob', body: 'Why?', url: 'u' }],
          },
        ],
      },
      'ada',
    );
    for (const argv of [
      ['review', 'reply', '7', '--path', here, '--thread', 'T1', '--body', 'Because'],
      ['review', 'resolve', '7', '--path', here, '--thread', 'T1'],
    ])
      expect(doc(z.unknown(), await abe(...argv))).toMatchObject({
        ok: false,
        error: { code: 'review-failed', message: AS_EVE },
      });
    expect(review.writes).toEqual([]);
    expect(stored().reply).toBeUndefined();
  });
});

describe('discussions', () => {
  const thread = {
    id: 'T1',
    path: 'src/small.ts',
    side: 'LEFT' as const,
    line: 3,
    start: 2,
    head: HEAD,
    outdated: false,
    resolved: false,
    canReply: true,
    canResolve: false,
    comments: [{ id: 90, author: 'bob', body: 'Why this range?', url: 'u' }],
  };

  test('a reply is kept before it goes; a sure refusal leaves it editable, an uncertain one only reconciles', async () => {
    await start({ discussions: [thread] });
    expect(
      doc(z.unknown(), await abe('review', 'resolve', '7', '--path', TREE, '--thread', 'T1')),
    ).toMatchObject({
      ok: false,
      error: { message: 'GitHub does not permit changing this discussion' },
    });
    review.answers.push({ ok: false, error: { code: 'refused', message: 'Permission expired' } });
    const refused = await abe(
      'review',
      'reply',
      '7',
      '--path',
      TREE,
      '--thread',
      'T1',
      '--body',
      'Because the old API needs it',
    );

    expect(doc(z.unknown(), refused)).toMatchObject({
      ok: false,
      error: { message: 'Permission expired; reply retained in Discussions' },
    });
    expect(stored().reply).toMatchObject({
      attempted: false,
      body: 'Because the old API needs it',
    });
    review.answers.push({ ok: false, error: { code: 'offline', message: 'Connection lost' } });
    await abe(
      'review',
      'reply',
      '7',
      '--path',
      TREE,
      '--thread',
      'T1',
      '--body',
      'Edited retained reply',
    );
    const id = stored().reply?.id;

    expect(stored().reply).toMatchObject({ attempted: true, body: 'Edited retained reply' });
    expect(
      doc(
        z.unknown(),
        await abe('review', 'reply', '7', '--path', TREE, '--thread', 'T1', '--body', 'Different'),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'review-refused' },
    });
    const retried = doc(
      ReviewDraftsData,
      await abe(
        'review',
        'reply',
        '7',
        '--path',
        TREE,
        '--thread',
        'T1',
        '--body',
        'Edited retained reply',
      ),
    );

    expect(retried).toMatchObject({ ok: true, data: { said: 'Reply posted' } });
    expect(review.writes.at(-1)).toMatchObject({
      kind: 'reply',
      commentId: 90,
      reconcileOnly: true,
      submission: id,
    });
    expect(stored().reply?.confirmed).toBe(true);
  });

  test('resolve where GitHub lets you', async () => {
    await start({ discussions: [{ ...thread, canResolve: true }] });
    expect(
      doc(ReviewSaidData, await abe('review', 'resolve', '7', '--path', TREE, '--thread', 'T1')),
    ).toEqual({
      ok: true,
      data: { said: 'Discussion resolved' },
    });
    expect(review.writes).toEqual([{ kind: 'resolve', thread: 'T1', resolved: true }]);
  });
});

describe('marks, the checkout, the pick', () => {
  test('a file marked reviewed as it is now, at the head', async () => {
    await start();
    const m = doc(
      ReviewMarksData,
      await abe('review', 'mark', '7', '--path', TREE, '--file', 'src/big.ts'),
    );

    if (!m.ok) throw new Error(m.error.message);
    expect(m.data.marks).toMatchObject({
      head: HEAD,
      paths: ['src/big.ts', 'src/small.ts', 'package-lock.json'],
    });
    expect(Object.keys(m.data.marks.marks)).toEqual(['src/big.ts']);
    const off = doc(
      ReviewMarksData,
      await abe('review', 'mark', '7', '--path', TREE, '--file', 'src/big.ts', '--off'),
    );

    expect(off.ok && off.data.marks.marks).toEqual({});
  });

  test("open: the worktree on the PR's branch, else its own beside the main checkout on that branch tracking the PR's; a failure on the main", async () => {
    await start({
      trees: [
        { path: MAIN, branch: 'main' },
        { path: '/work/shop-cart', branch: 'feature/cart' },
      ],
    });
    expect(doc(ReviewOpenData, await abe('review', 'open', '7', '--path', MAIN))).toEqual({
      ok: true,
      data: { repo: 'acme/shop', number: 7, path: '/work/shop-cart', unchecked: null },
    });
    review.trees = [{ path: MAIN, branch: 'main' }];
    review.checkout = { ok: false, error: { code: 'offline', message: 'origin not reached' } };
    expect(doc(ReviewOpenData, await abe('review', 'open', '7', '--path', MAIN))).toEqual({
      ok: true,
      data: { repo: 'acme/shop', number: 7, path: MAIN, unchecked: 'origin not reached' },
    });
    // the main checkout on the PR's branch: a branch of its own, still tracking the PR's
    review.trees = [{ path: MAIN, branch: 'feature/cart' }];
    review.checkout = undefined;
    await abe('review', 'open', '7', '--path', MAIN);
    const cart = { upstream: 'feature/cart' };

    expect(review.writes).toEqual([
      { kind: 'checkout', path: '/work/shop-cart', branch: 'feature/cart', reuse: true, ...cart },
      { kind: 'checkout', path: '/work/shop-pr-7', branch: 'feature/cart', reuse: false, ...cart },
      { kind: 'checkout', path: '/work/shop-pr-7', branch: 'pr-7', reuse: false, ...cart },
    ]);
  });

  test("the pick: the checkout's repo, who you are and its open PRs", async () => {
    await start({
      open: [{ number: 8, title: 'Mine', author: 'ada', branch: 'x', draft: false, requested: [] }],
    });
    expect(doc(ReviewPrsData, await abe('review', 'prs', '--path', MAIN))).toEqual({
      ok: true,
      data: {
        repo: 'acme/shop',
        me: 'ada',
        prs: [
          { number: 8, title: 'Mine', author: 'ada', branch: 'x', draft: false, requested: [] },
        ],
      },
    });
  });
});

describe('Create Draft PR', () => {
  const plan = {
    root: MAIN,
    repo: 'acme/shop',
    branch: 'feature/AB-12-pay',
    head: 'abc',
    base: 'main',
    origin: 'https://github.com/acme/shop.git',
    title: 'Pay by card',
    body: 'Card: AB#12',
    commits: 1,
    files: 1,
    uncommitted: [],
    published: false,
    existing: null,
    branches: ['main'],
    reviewers: [{ login: 'bob', name: 'Bob' }],
  };

  test('made from the plan read, its reviewers asked; refused when the branch moved', async () => {
    await start({ plan });
    expect(doc(z.unknown(), await abe('pr', 'draft-plan', '--path', MAIN))).toMatchObject({
      ok: true,
      data: { title: 'Pay by card' },
    });
    const made = doc(
      DraftPrMadeData,
      await abe(
        'pr',
        'draft-create',
        '--path',
        MAIN,
        '--repo',
        plan.repo,
        '--branch',
        plan.branch,
        '--head',
        'abc',
        '--base',
        'main',
        '--title',
        'Pay',
        '--body',
        'b',
        '--push',
        '--reviewer',
        'bob',
      ),
    );

    expect(made).toEqual({
      ok: true,
      data: { number: 31, url: 'https://github.com/acme/shop/pull/31', asked: null },
    });
    expect(review.writes).toEqual([
      { kind: 'draft', title: 'Pay', base: 'main', push: true },
      { kind: 'reviewers', logins: ['bob'] },
    ]);
    const moved = await abe(
      'pr',
      'draft-create',
      '--path',
      MAIN,
      '--repo',
      plan.repo,
      '--branch',
      plan.branch,
      '--head',
      'other',
      '--base',
      'main',
      '--title',
      'Pay',
    );

    expect(doc(z.unknown(), moved)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    // origin names another repository now
    const elsewhere = await abe(
      'pr',
      'draft-create',
      '--path',
      MAIN,
      '--repo',
      'acme/other',
      '--branch',
      plan.branch,
      '--head',
      plan.head,
      '--base',
      'main',
      '--title',
      'Pay',
    );

    expect(doc(z.unknown(), elsewhere)).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  test('refused while gh is signed in as another login than githubIdentity', async () => {
    await start({ plan, login: 'eve' }, 'ada');
    const made = await abe(
      'pr',
      'draft-create',
      '--path',
      here,
      '--repo',
      plan.repo,
      '--branch',
      plan.branch,
      '--head',
      'abc',
      '--base',
      'main',
      '--title',
      'Pay',
    );

    expect(doc(z.unknown(), made)).toMatchObject({
      ok: false,
      error: { code: 'review-failed', message: AS_EVE },
    });
    expect(review.writes).toEqual([]);
  });

  test('without the port it is refused', async () => {
    s = await scenario();
    expect(
      doc(z.unknown(), await s.request('review', 'prs', '--path', MAIN, '--json')),
    ).toMatchObject({
      ok: false,
      error: { code: 'no-review' },
    });
  });
});
