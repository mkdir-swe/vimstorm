/**
 * The review port: git's readings of a PR's checkout (a real repository with a bare origin, its
 * `refs/pull/<n>/head` as GitHub keeps one), the docs in the main checkout's `.scratch/abe`
 * (1.x's shape, other fields kept), and GitHub through a fake `gh`: the PR read, the discussions,
 * a review marked with its submission and read back so a retry never posts twice.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftBody, type ReviewOut } from '@abe/core';
import { z } from 'zod';
import { fakeGh, type FakeGh, ghUser } from '@abe/testing';
import { ghRunner } from './gh';
import { reviewPort, reviewPortFrom } from './review';
import { changedFiles, parseLog, parsePatches, renamedPath, reviewGit } from '../git/review-git';
import { reviewGithub } from './review-github';

const ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.test',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const write = (repo: string, file: string, text: string) => {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), text);
};

const RS = '\u001e';
const US = '\u001f';

describe("git's readings", () => {
  test('the three readings make the files, renames, binaries and deletes included', () => {
    const numstat =
      '3\t1\tsrc/a.ts\0-\t-\tlogo.png\x000\t2\told.ts\x001\t1\0src/b.ts\0src/bee.ts\0';
    const names = 'M\0src/a.ts\0A\0logo.png\0D\0old.ts\0R100\0src/b.ts\0src/bee.ts\0';
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n-a\n+b\n+c\n+d\n',
      'diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ\n',
      'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n',
      'diff --git a/src/b.ts b/src/bee.ts\nsimilarity index 100%\nrename from src/b.ts\nrename to src/bee.ts\n',
    ].join('');
    const files = changedFiles(numstat, names, patch);

    expect(
      files.map((f) => [f.path, f.previous, f.status, f.additions, f.deletions, f.binary]),
    ).toEqual([
      ['src/a.ts', undefined, 'M', 3, 1, false],
      ['logo.png', undefined, 'A', 0, 0, true],
      ['old.ts', undefined, 'D', 0, 2, false],
      ['src/bee.ts', 'src/b.ts', 'R', 1, 1, false],
    ]);
    expect(files.map((f) => f.patch)).toEqual([
      '@@ -1 +1,3 @@\n-a\n+b\n+c\n+d',
      '',
      '@@ -1,2 +0,0 @@\n-x\n-y',
      '',
    ]);
    expect(files[3]?.similarity).toBe(100);
  });

  test("a log's records, renamed numstat paths and each commit's patches", () => {
    const log = `${RS}abc${US}Fix it${US}Ada${US}2026-01-01T00:00:00+00:00\n2\t0\tsrc/{old => new}/x.ts\n-\t-\timg.png\n\n${RS}def${US}Two${US}Bob${US}2026-01-02T00:00:00+00:00\n1\t1\ta.ts\n`;
    const commits = parseLog(log);

    expect(commits.map((c) => [c.sha, c.subject, c.author])).toEqual([
      ['abc', 'Fix it', 'Ada'],
      ['def', 'Two', 'Bob'],
    ]);
    expect(commits[0]?.files[0]).toMatchObject({ path: 'src/new/x.ts', previous: 'src/old/x.ts' });
    expect(commits[0]?.files[1]?.binary).toBe(true);
    expect(renamedPath('a.ts => b.ts')).toEqual({ path: 'b.ts', previous: 'a.ts' });
    expect(
      parsePatches(
        `${RS}abc\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n`,
      )
        .get('abc')
        ?.get('a.ts'),
    ).toBe('@@ -1 +1 @@\n-a\n+b');
  });
});

const PAD = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
};
const LOCK = {
  name: 'shop',
  lockfileVersion: 3,
  packages: { '': {}, 'node_modules/left-pad': PAD },
};

describe('a PR checked out', () => {
  let root: string;
  let main: string;
  let head: string;
  let base: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-review-')));
    const origin = join(root, 'origin.git');

    main = join(root, 'shop');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, main);
    git(main, 'config', 'remote.origin.url', 'https://github.com/acme/shop.git');
    git(main, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/shop.git');
    write(main, 'package.json', '{}\n');
    write(main, 'web/package.json', '{}\n');
    write(main, 'web/a.ts', 'one\ntwo\nthree\n');
    write(main, 'old.ts', 'x\ny\n');
    write(main, 'c.ts', 'same\n');
    write(main, '.gitignore', '.env\nnode_modules/\n');
    write(main, 'package-lock.json', JSON.stringify(LOCK));
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'base');
    git(main, 'push', '-q', 'origin', 'main');
    base = git(main, 'rev-parse', 'HEAD');
    git(main, 'checkout', '-q', '-b', 'feature/cart');
    write(main, 'web/a.ts', 'one\nTWO\nthree\n');
    git(main, 'commit', '-q', '-am', 'Change two');
    git(main, 'mv', 'c.ts', 'd.ts');
    git(main, 'rm', '-q', 'old.ts');
    write(main, 'b.ts', 'new\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'Move and add');
    head = git(main, 'rev-parse', 'HEAD');
    git(main, 'push', '-q', 'origin', 'feature/cart');
    git(origin, 'update-ref', 'refs/pull/7/head', head);
    git(main, 'checkout', '-q', 'main');
    // the main checkout's own files and install, none of them git's
    write(main, 'CLAUDE.md', 'notes\n');
    write(main, '.env', 'KEY=1\n');
    write(
      main,
      'node_modules/.package-lock.json',
      JSON.stringify({ packages: { 'node_modules/left-pad': PAD } }),
    );
    write(main, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('its own worktree beside the main checkout, its files against the merge base', async () => {
    const port = reviewGit(ENV);
    const path = `${main}-pr-7`;
    const out = await port.checkoutPr({
      main,
      path,
      number: 7,
      branch: 'pr-7',
      base: 'main',
      reuse: false,
    });

    expect(out).toEqual({ ok: true, data: { path, head } });
    // given the main checkout's local-only files (excluded there) and its install as links
    expect(readFileSync(join(path, 'CLAUDE.md'), 'utf8')).toBe('notes\n');
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('KEY=1\n');
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(lstatSync(join(path, 'node_modules', 'left-pad')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, 'node_modules', 'left-pad'))).toBe(
      join(main, 'node_modules', 'left-pad'),
    );
    expect(await port.mainOf(path)).toEqual({ ok: true, data: main });
    expect(await port.originUrl(path)).toBe('https://github.com/acme/shop.git');
    const changes = await port.changes(path, 'origin/main');

    if (!changes.ok) throw new Error(changes.error.message);
    expect(changes.data.base).toBe(base);
    expect(changes.data.head).toBe(head);
    expect(changes.data.files.map((f) => [f.status, f.path, f.previous])).toEqual([
      ['A', 'b.ts', undefined],
      ['R', 'd.ts', 'c.ts'],
      ['D', 'old.ts', undefined],
      ['M', 'web/a.ts', undefined],
    ]);
    expect(changes.data.files[3]?.patch).toContain('-two\n+TWO');
    const commits = await port.commits(path, base, head);

    expect(commits.ok && commits.data.map((c) => c.subject)).toEqual([
      'Change two',
      'Move and add',
    ]);
    expect(commits.ok && commits.data[0]?.files[0]?.patch).toContain('+TWO');
    expect(await port.packages(path)).toEqual({ ok: true, data: ['', 'web'] });
    const trees = await port.worktrees(main);

    expect(trees.ok && trees.data.find((t) => t.path === path)?.branch).toBe('pr-7');
    // again: reused where it is
    expect(
      await port.checkoutPr({ main, path, number: 7, branch: 'pr-7', base: 'main', reuse: true }),
    ).toEqual({ ok: true, data: { path, head } });
    expect(
      (await port.checkoutPr({ main, path, number: 7, branch: 'pr-7', base: 'main', reuse: false }))
        .ok,
    ).toBe(false);
  });

  test("on the PR's own branch it tracks the PR's, so a push reaches the PR; a fork's by its URL", async () => {
    const port = reviewGit(ENV);
    const path = `${main}-cart`;
    const out = await port.checkoutPr({
      main,
      path,
      number: 7,
      branch: 'feature/cart',
      base: 'main',
      reuse: false,
      upstream: { ref: 'feature/cart' },
    });

    expect(out).toEqual({ ok: true, data: { path, head } });
    expect(git(path, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature/cart');
    write(path, 'fix.ts', 'fixup\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'Fixup');
    const fixup = git(path, 'rev-parse', 'HEAD');

    git(path, 'push', '-q');
    const origin = join(root, 'origin.git');

    expect(git(origin, 'rev-parse', 'refs/heads/feature/cart')).toBe(fixup);
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).not.toContain('pr-7');
    // a fork's head: the fork's URL in origin's protocol, its branch merged
    git(path, 'checkout', '-q', '-b', 'ada-cart');
    expect(
      (
        await port.checkoutPr({
          main,
          path,
          number: 7,
          branch: 'ada-cart',
          base: 'main',
          reuse: true,
          upstream: { ref: 'cart', fork: { owner: 'ada', repo: 'shop' } },
        })
      ).ok,
    ).toBe(true);
    expect(git(path, 'config', 'branch.ada-cart.remote')).toBe('https://github.com/ada/shop.git');
    expect(git(path, 'config', 'branch.ada-cart.merge')).toBe('refs/heads/cart');
    git(path, 'checkout', '-q', 'feature/cart');
    git(main, 'worktree', 'remove', '--force', path);
  });

  test('a commit not in the checkout is said so', async () => {
    const commits = await reviewGit(ENV).commits(main, 'f'.repeat(40), 'HEAD');

    expect(commits).toEqual({
      ok: false,
      error: { code: 'not-found', message: `git: fffffff is not in ${main}` },
    });
  });

  test('the docs in the main checkout keep the fields another writer added', async () => {
    const port = reviewPortFrom(reviewGit(ENV), reviewGithub(ghRunner(ENV)));
    const dir = join(main, '.scratch', 'abe');

    expect(await port.marks(main, 7)).toEqual({ ok: true, data: null });
    expect(await port.drafts(main, 7)).toEqual({ ok: true, data: { drafts: [] } });
    mkdirSync(join(dir, 'drafts'), { recursive: true });
    // a damaged doc is said so (the next write would lose its drafts)
    writeFileSync(join(dir, 'drafts', '7.json'), '{"drafts": [');
    expect(await port.drafts(main, 7)).toMatchObject({ ok: false, error: { code: 'failed' } });
    writeFileSync(
      join(dir, 'drafts', '7.json'),
      JSON.stringify({
        at: 5,
        theirs: true,
        drafts: [{ seq: 1, path: 'a.ts', line: { side: 'RIGHT', line: 2 }, body: 'x', note: 1 }],
        review: { head: 'h', verdict: 'RequestChanges', body: 'no' },
      }),
    );
    const read = await port.drafts(main, 7);

    if (!read.ok) throw new Error(read.error.message);
    expect(read.data.review?.verdict).toBe('RequestChanges');
    await port.putDrafts(main, 7, { ...read.data, at: 6 });
    const kept: unknown = JSON.parse(readFileSync(join(dir, 'drafts', '7.json'), 'utf8'));

    expect(kept).toMatchObject({ at: 6, theirs: true, drafts: [{ note: 1 }] });
    await port.putMarks(main, 7, {
      head: 'h',
      paths: ['a.ts'],
      marks: { 'a.ts': { hash: 'x', head: 'h' } },
    });
    expect(existsSync(join(dir, 'marks', '7.json'))).toBe(true);
    expect((await port.marks(main, 7)).ok).toBe(true);
  });
});

describe("1.x's docs", () => {
  test('a drafts and a marks doc 1.x wrote read and written back are its bytes', async () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'abe-docs-')));
    const port = reviewPortFrom(reviewGit(ENV), reviewGithub(ghRunner(ENV)));

    try {
      for (const family of ['drafts', 'marks'] as const) {
        const text = readFileSync(
          join(import.meta.dir, 'fixtures', 'review', `${family}-2041.json`),
          'utf8',
        );
        const file = join(main, '.scratch', 'abe', family, '2041.json');

        mkdirSync(join(main, '.scratch', 'abe', family), { recursive: true });
        writeFileSync(file, text);
        if (family === 'drafts') {
          const read = await port.drafts(main, 2041);

          if (!read.ok) throw new Error(read.error.message);
          expect(read.data.drafts.map((d) => [d.seq, d.line.line, d.start?.line, d.sent])).toEqual([
            [2, 12, undefined, undefined],
            [1, 5, 3, '2026-10-01T09:30:00.000Z'],
          ]);
          await port.putDrafts(main, 2041, read.data);
        } else {
          const read = await port.marks(main, 2041);

          if (!read.ok || read.data === null) throw new Error('no marks');
          expect(read.data.marks['src/b.ts']).toEqual({ hash: 'h1', head: 'abc123' });
          await port.putMarks(main, 2041, read.data);
        }
        expect(readFileSync(file, 'utf8')).toBe(text);
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("GitHub's side", () => {
  let gh: FakeGh | undefined;

  afterEach(() => {
    gh?.remove();
  });

  const port = (answers: Parameters<typeof fakeGh>[0]) => {
    gh = fakeGh(answers);

    return { gh, github: reviewGithub(ghRunner({ PATH: gh.path })) };
  };

  test('the PR as the review reads it: state, decision, checks counted', async () => {
    const { github } = port([
      [
        'pr view 7',
        {
          json: {
            number: 7,
            title: 'Cart',
            url: 'https://github.com/acme/shop/pull/7',
            author: { login: 'bob' },
            headRefName: 'feature/cart',
            headRefOid: 'h1',
            baseRefName: 'main',
            body: 'b',
            state: 'OPEN',
            isDraft: false,
            reviewDecision: 'REVIEW_REQUIRED',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [
              { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
              { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
              { __typename: 'StatusContext', context: 'ci', state: 'PENDING' },
            ],
            updatedAt: '2026-11-01T10:05:00Z',
            comments: [
              { author: { login: 'ada' }, body: 'Ship it?', createdAt: '2026-11-01T10:02:00Z' },
            ],
            reviews: [
              {
                author: { login: 'cy' },
                body: '',
                state: 'COMMENTED',
                submittedAt: '2026-11-01T10:01:00Z',
              },
              {
                author: { login: 'cy' },
                body: 'One nit',
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-11-01T10:03:00Z',
              },
              { author: { login: 'me' }, body: 'wip', state: 'PENDING', submittedAt: null },
            ],
          },
        },
      ],
    ]);

    expect(await github.pr('acme/shop', 7)).toEqual({
      ok: true,
      data: {
        repo: 'acme/shop',
        number: 7,
        title: 'Cart',
        url: 'https://github.com/acme/shop/pull/7',
        author: 'bob',
        branch: 'feature/cart',
        base: 'main',
        body: 'b',
        state: 'open',
        draft: false,
        head: 'h1',
        decision: 'required',
        mergeable: 'mergeable',
        mergeState: 'blocked',
        checks: { total: 3, passed: 1, failed: 1, failing: ['lint'], running: true },
        updatedAt: '2026-11-01T10:05:00Z',
        // the conversation, oldest first: a review that only wraps line comments and a pending one
        // left out
        conversation: [
          { kind: 'comment', author: 'ada', body: 'Ship it?', at: '2026-11-01T10:02:00Z' },
          { kind: 'changes', author: 'cy', body: 'One nit', at: '2026-11-01T10:03:00Z' },
        ],
      },
    });
  });

  test('discussions: an outdated one on its original line and commit, pending comments left out', async () => {
    const comment = (id: number, state: string | null) => ({
      databaseId: String(id),
      author: { login: 'bob' },
      body: `c${id}`,
      url: `u${id}`,
      originalCommit: { oid: 'old1' },
      pullRequestReview: state === null ? null : { state },
    });
    const { github } = port([
      [
        'query ReviewThreads',
        {
          json: {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: 'h1',
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'T1',
                        path: 'a.ts',
                        diffSide: 'RIGHT',
                        line: null,
                        startLine: null,
                        originalLine: 4,
                        originalStartLine: null,
                        isOutdated: true,
                        isResolved: false,
                        viewerCanReply: true,
                        viewerCanResolve: true,
                        viewerCanUnresolve: false,
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [comment(11, 'COMMENTED'), comment(12, 'PENDING')],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    ]);

    expect(await github.threads('acme/shop', 7)).toEqual({
      ok: true,
      data: [
        {
          id: 'T1',
          path: 'a.ts',
          side: 'RIGHT',
          line: 4,
          start: null,
          head: 'old1',
          outdated: true,
          resolved: false,
          canReply: true,
          canResolve: true,
          comments: [{ id: 11, author: 'bob', body: 'c11', url: 'u11' }],
        },
      ],
    });
  });

  const review: ReviewOut = {
    submission: '102-abc',
    reconcileOnly: false,
    pr: 7,
    commit: 'h1',
    verdict: 'RequestChanges',
    body: 'Fix it',
    comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'why?' }],
  };

  test('a review goes once, marked with its submission; a retry finds it and posts nothing', async () => {
    const { gh, github } = port([
      ['api user', { stdout: 'ada' }],
      ['pulls/7/reviews?per_page', { json: [[]] }],
      ['--method POST repos/acme/shop/pulls/7/reviews', { json: { id: 9 } }],
      ['api repos/acme/shop/pulls/7', { json: { head: { sha: 'h1' } } }],
    ]);

    expect(await github.submit('acme/shop', review)).toEqual({ ok: true, data: null });
    const post = gh.calls().find((c) => c.argv.includes('POST'));
    const body = z
      .object({ body: z.string(), event: z.string(), commit_id: z.string() })
      .parse(JSON.parse(post?.stdin ?? '{}'));

    expect(body.event).toBe('REQUEST_CHANGES');
    expect(body.commit_id).toBe('h1');
    expect(body.body).toMatch(/^Fix it\n\n<!-- vimstorm-review-v1:[0-9a-f]{14}:[0-9a-f]{14} -->$/);
    // the retry: GitHub has it, with its comment
    gh.answer([
      ['api user', { stdout: 'ada' }],
      [
        'pulls/7/reviews/9/comments',
        {
          json: [
            [
              {
                user: { login: 'ada' },
                path: 'a.ts',
                side: 'RIGHT',
                original_line: 3,
                body: 'why?',
              },
            ],
          ],
        },
      ],
      [
        'pulls/7/reviews?per_page',
        {
          json: [
            [
              {
                id: 9,
                user: { login: 'Ada' },
                body: body.body,
                commit_id: 'h1',
                submitted_at: '2026-10-25T10:00:00Z',
                state: 'CHANGES_REQUESTED',
              },
            ],
          ],
        },
      ],
    ]);
    const before = gh.calls().length;

    expect(await github.submit('acme/shop', { ...review, reconcileOnly: true })).toEqual({
      ok: true,
      data: null,
    });
    expect(
      gh
        .calls()
        .slice(before)
        .some((c) => c.argv.includes('POST')),
    ).toBe(false);
  });

  test('a retry that finds nothing never posts; a moved head refuses the first try', async () => {
    const { gh, github } = port([
      ['api user', { stdout: 'ada' }],
      ['pulls/7/reviews?per_page', { json: [[]] }],
      ['api repos/acme/shop/pulls/7', { json: { head: { sha: 'h2' } } }],
    ]);

    expect(await github.submit('acme/shop', { ...review, reconcileOnly: true })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(await github.submit('acme/shop', review)).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: 'The pull-request head changed; refresh before submitting the review',
      },
    });
    expect(gh.calls().some((c) => c.argv.includes('POST'))).toBe(false);
  });

  test('a reply and a comment posted now are marked; resolve is confirmed', async () => {
    const { gh, github } = port([
      ['api user', { stdout: 'ada' }],
      ['pulls/7/comments?per_page', { json: [[]] }],
      ['api repos/acme/shop/pulls/7', { json: { head: { sha: 'h1' } } }],
      ['--method POST', { json: { id: 50 } }],
      [
        'resolveReviewThread',
        { json: { data: { resolveReviewThread: { thread: { id: 'T1', isResolved: true } } } } },
      ],
    ]);

    expect(
      await github.reply({
        repo: 'acme/shop',
        number: 7,
        commentId: 11,
        submission: 'r1',
        reconcileOnly: false,
        body: 'ok',
      }),
    ).toEqual({ ok: true, data: null });
    expect(
      await github.postComment({
        repo: 'acme/shop',
        number: 7,
        head: 'h1',
        submission: 's1',
        reconcileOnly: false,
        comment: { path: 'a.ts', line: 3, side: 'RIGHT', body: 'now' },
      }),
    ).toEqual({ ok: true, data: null });
    const posts = gh.calls().filter((c) => c.argv.includes('POST'));

    expect(posts.map((c) => c.argv.find((a) => a.startsWith('repos/')))).toEqual([
      'repos/acme/shop/pulls/7/comments/11/replies',
      'repos/acme/shop/pulls/7/comments',
    ]);
    expect(z.object({ body: z.string() }).parse(JSON.parse(posts[0]?.stdin ?? '{}')).body).toMatch(
      /^ok\n\n<!-- vimstorm:reply:[0-9a-f]{14} -->$/,
    );
    expect(await github.resolve('T1', true)).toEqual({ ok: true, data: null });
  });

  test('the PR pick: open PRs with who is asked to review', async () => {
    const { github } = port([
      [
        'pr list --repo acme/shop --state open',
        {
          json: [
            {
              number: 8,
              title: 'Mine',
              author: { login: 'ada' },
              headRefName: 'feature/x',
              isDraft: true,
              reviewRequests: [{ login: 'bob' }, { slug: 'web' }],
            },
          ],
        },
      ],
      ['api user', { json: ghUser('ada') }],
    ]);

    expect(await github.prs('acme/shop')).toEqual({
      ok: true,
      data: [
        {
          number: 8,
          title: 'Mine',
          author: 'ada',
          branch: 'feature/x',
          draft: true,
          requested: ['bob', 'web'],
        },
      ],
    });
  });
});

describe('Create Draft PR', () => {
  test("the description names the card the branch names, then the commits' subjects", () => {
    expect(draftBody('abe/AB-1234-cart-total', ['Add shipping', 'Free over 499'])).toBe(
      'Card: AB#1234\n\n## What\n- Add shipping\n- Free over 499',
    );
    expect(draftBody('fix/login', [])).toBe('');
    expect(draftBody('feature/native-pr', ['Export summary'])).toBe('## What\n- Export summary');
  });

  test('the plan reads the branch; create pushes the head shown, then opens the draft', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-draft-')));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'shop');
    const gh = fakeGh([
      ['repo view acme/shop --json defaultBranchRef', { stdout: 'main' }],
      ['pr list --repo acme/shop --head feature/AB-12-pay', { json: [] }],
      ['api user', { stdout: 'ada' }],
      [
        'assignableUsers',
        {
          json: [
            { login: 'ada', name: 'Ada' },
            { login: 'bob', name: 'Bob' },
          ],
        },
      ],
      ['pr create', { stdout: 'https://github.com/acme/shop/pull/31\n' }],
    ]);

    try {
      git(root, 'init', '-q', '--bare', '-b', 'main', origin);
      git(root, 'clone', '-q', origin, repo);
      git(repo, 'config', 'remote.origin.url', 'https://github.com/acme/shop.git');
      git(repo, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/shop.git');
      write(repo, 'a.ts', 'a\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'base');
      git(repo, 'push', '-q', 'origin', 'main');
      git(repo, 'checkout', '-q', '-b', 'feature/AB-12-pay');
      write(repo, 'a.ts', 'b\n');
      git(repo, 'commit', '-q', '-am', 'Pay by card');
      const port = reviewPort(ENV, ghRunner({ PATH: gh.path }));
      const plan = await port.draftPlan(repo);

      if (!plan.ok) throw new Error(plan.error.message);
      expect(plan.data).toMatchObject({
        repo: 'acme/shop',
        branch: 'feature/AB-12-pay',
        base: 'main',
        title: 'Pay by card',
        body: 'Card: AB#12\n\n## What\n- Pay by card',
        commits: 1,
        files: 1,
        published: false,
        existing: null,
        branches: ['main'],
        reviewers: [{ login: 'bob', name: 'Bob' }],
      });
      expect(
        await port.draftCreate({
          plan: plan.data,
          title: 'Pay',
          body: 'b',
          base: 'main',
          push: false,
        }),
      ).toMatchObject({ ok: false, error: { code: 'refused' } });
      expect(
        await port.draftCreate({
          plan: plan.data,
          title: 'Pay',
          body: 'b',
          base: 'main',
          push: true,
        }),
      ).toEqual({ ok: true, data: { number: 31, url: 'https://github.com/acme/shop/pull/31' } });
      expect(git(origin, 'rev-parse', 'refs/heads/feature/AB-12-pay')).toBe(plan.data.head);
      expect(gh.calls().find((c) => c.argv[1] === 'create')?.argv).toContain('--draft');
    } finally {
      gh.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
