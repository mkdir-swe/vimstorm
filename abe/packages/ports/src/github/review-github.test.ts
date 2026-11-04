/**
 * The review's GitHub writes against providers that misbehave as GitHub can (1.x's
 * `crates/abe-ports/tests/github_threads.rs` and `github_review_submit.rs`): every page of the
 * discussions and of their comments, permission errors never an empty list, a reply's preflight
 * failure safe to try again, and lost answers read back so nothing is posted twice: a review, a
 * comment posted now, a reply.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type ReviewComment, type ReviewOut } from '@abe/core';
import { fakeGh, type FakeGh } from '@abe/testing';
import { ghRunner } from './gh';
import { reviewGithub } from './review-github';

/** A JSON object the fake read: its fields. */
const fields = (text: string): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(text));

const REPO = 'octo/project';

let gh: FakeGh | undefined;
const dirs: string[] = [];

afterEach(() => {
  gh?.remove();
  gh = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const recorded = (answers: Parameters<typeof fakeGh>[0]) => {
  gh = fakeGh(answers);

  return { gh, github: reviewGithub(ghRunner({ PATH: gh.path })) };
};

/** A gh script of our own (a provider with state), its calls logged in its folder. */
const scripted = (script: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-gh-'));

  dirs.push(dir);
  writeFileSync(join(dir, 'gh'), script.replaceAll('{dir}', dir), { mode: 0o755 });
  chmodSync(join(dir, 'gh'), 0o755);

  return {
    dir,
    github: reviewGithub(ghRunner({ PATH: `${dir}:/usr/bin:/bin` })),
    posts: () =>
      existsSync(join(dir, 'calls'))
        ? readFileSync(join(dir, 'calls'), 'utf8')
            .split('\n')
            .filter((l) => l.includes('--method POST')).length
        : 0,
  };
};

const comments = (nodes: unknown[], next: string | null) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});

const comment = (id: number, body: string) => ({
  databaseId: String(id),
  author: { login: 'reviewer' },
  body,
  url: `https://github.com/${REPO}/pull/7#discussion_r${id}`,
  originalCommit: { oid: 'original-head' },
});

const thread = (id: string, side: string, notes: unknown) => ({
  id,
  path: 'src/main.rs',
  diffSide: side,
  line: 19,
  startLine: 17,
  originalLine: 9,
  originalStartLine: 7,
  isOutdated: false,
  isResolved: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: notes,
});

const page = (nodes: unknown[], next: string | null) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid: 'reviewed-head',
        reviewThreads: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } },
      },
    },
  },
});

describe('discussions', () => {
  test('every page of threads and comments, with anchors and permissions', async () => {
    const old = {
      ...thread('PRRT_old', 'LEFT', comments([comment(43, 'Old discussion')], null)),
      isOutdated: true,
      isResolved: true,
      line: null,
      startLine: null,
      viewerCanReply: false,
      viewerCanResolve: false,
      viewerCanUnresolve: true,
    };
    const { github } = recorded([
      [
        'cursor=comments-next',
        { json: { data: { node: { comments: comments([comment(42, 'Answer')], null) } } } },
      ],
      ['cursor=threads-next', { json: page([old], null) }],
      [
        'graphql',
        {
          json: page(
            [thread('PRRT_first', 'RIGHT', comments([comment(41, 'Question')], 'comments-next'))],
            'threads-next',
          ),
        },
      ],
    ]);
    const read = await github.threads(REPO, 7);

    if (!read.ok) throw new Error(read.error.message);
    const [first, second] = read.data;

    expect(first).toMatchObject({
      id: 'PRRT_first',
      path: 'src/main.rs',
      side: 'RIGHT',
      line: 19,
      start: 17,
      head: 'reviewed-head',
      outdated: false,
      resolved: false,
      canReply: true,
      canResolve: true,
    });
    expect(first?.comments.map((c) => [c.id, c.body])).toEqual([
      [41, 'Question'],
      [42, 'Answer'],
    ]);
    expect(second).toMatchObject({
      side: 'LEFT',
      line: 9,
      start: 7,
      outdated: true,
      resolved: true,
      canReply: false,
      canResolve: true,
      head: 'original-head',
    });
  });

  test('a permission error or a missing connection is never an empty list', async () => {
    const forbidden = recorded([
      [
        'graphql',
        {
          json: {
            data: { repository: null },
            errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }],
          },
        },
      ],
    ]);

    expect(await forbidden.github.threads(REPO, 7)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    forbidden.gh.answer([['graphql', { json: { data: { repository: null } } }]]);
    expect((await forbidden.github.threads(REPO, 7)).ok).toBe(false);
    forbidden.gh.answer([['graphql', { json: page([], null) }]]);
    expect(await forbidden.github.threads(REPO, 7)).toEqual({ ok: true, data: [] });
  });
});

describe('a reply', () => {
  test('goes under the first comment with its text intact and its marker', async () => {
    const { gh, github } = recorded([
      ['api user', { stdout: 'reviewer' }],
      ['--paginate', { json: [[]] }],
      ['pulls/7/comments/41/replies', { json: {} }],
    ]);

    expect(
      await github.reply({
        repo: REPO,
        number: 7,
        commentId: 41,
        submission: 'reply-op',
        reconcileOnly: false,
        body: 'Yes, with `code`.\nSecond line.',
      }),
    ).toEqual({ ok: true, data: null });
    const post = gh.calls().at(-1);

    expect(post?.argv).toEqual([
      'api',
      '--method',
      'POST',
      'repos/octo/project/pulls/7/comments/41/replies',
      '--input',
      '-',
    ]);
    expect(post?.stdin).toMatch(
      /^\{"body":"Yes, with `code`\.\\nSecond line\.\\n\\n<!-- vimstorm:reply:[0-9a-f]{14} -->"\}$/,
    );
  });

  test('a preflight failure may be tried afresh; a retry of an attempted one keeps its own', async () => {
    for (const failing of ['api user', '--paginate']) {
      const { gh, github } = recorded([
        [failing, { stderr: 'error connecting: preflight unavailable', exit: 1 }],
        ['api user', { stdout: 'reviewer' }],
      ]);
      const reply = {
        repo: REPO,
        number: 7,
        commentId: 41,
        submission: 'op',
        body: 'Reply after a read recovers',
      };

      expect(await github.reply({ ...reply, reconcileOnly: false })).toEqual({
        ok: false,
        error: { code: 'precondition', message: 'gh: error connecting: preflight unavailable' },
      });
      expect(await github.reply({ ...reply, reconcileOnly: true })).toMatchObject({
        ok: false,
        error: { code: 'offline' },
      });
      expect(gh.calls().some((c) => c.argv.includes('POST'))).toBe(false);
      gh.remove();
    }
  });

  test('a lost answer is read back, also once GitHub shows it late; another root or author is not it', async () => {
    for (const delayed of [false, true]) {
      const fake = scripted(`#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path('{dir}')
args = sys.argv[1:]
with (root / 'calls').open('a') as log:
    log.write(' '.join(args) + '\\n')
if args[:2] == ['api', 'user']:
    print('reviewer')
elif '--paginate' in args:
    state = root / 'posted'
    visible = (root / 'visible').exists()
    print(state.read_text() if state.exists() and visible else '[[]]')
elif '--method' in args:
    sent = json.load(sys.stdin)
    receipt = dict(sent, user={'login':'reviewer'}, in_reply_to_id=41)
    (root / 'posted').write_text(json.dumps([[], [receipt]]))
    print('error connecting: response lost', file=sys.stderr)
    sys.exit(1)
else:
    sys.exit(2)
`);
      const reply = {
        repo: REPO,
        number: 7,
        commentId: 41,
        submission: 'persisted',
        body: 'Reply after considering the code',
      };

      if (!delayed) writeFileSync(join(fake.dir, 'visible'), '');
      const first = await fake.github.reply({ ...reply, reconcileOnly: false });

      if (delayed) {
        expect(first).toMatchObject({ ok: false, error: { code: 'offline' } });
        expect(await fake.github.reply({ ...reply, reconcileOnly: true })).toMatchObject({
          ok: false,
          error: { code: 'conflict' },
        });
        writeFileSync(join(fake.dir, 'visible'), '');
      } else expect(first.ok).toBe(true);
      expect((await fake.github.reply({ ...reply, reconcileOnly: true })).ok).toBe(true);
      expect(
        await fake.github.reply({ ...reply, commentId: 42, reconcileOnly: true }),
      ).toMatchObject({ ok: false, error: { code: 'conflict' } });
      const file = join(fake.dir, 'posted');
      const receipts = z
        .tuple([z.array(z.unknown()), z.array(z.record(z.string(), z.unknown()))])
        .parse(JSON.parse(readFileSync(file, 'utf8')));
      const [, [receipt]] = receipts;

      if (receipt === undefined) throw new Error('no receipt');
      writeFileSync(
        file,
        JSON.stringify([[], [{ ...receipt, user: { login: 'another-reviewer' } }]]),
      );
      expect(await fake.github.reply({ ...reply, reconcileOnly: true })).toMatchObject({
        ok: false,
        error: { code: 'conflict' },
      });
      expect(fake.posts()).toBe(1);
    }
  });
});

describe('a comment posted now', () => {
  const left: ReviewComment = {
    path: 'deleted.rs',
    line: 9,
    side: 'LEFT',
    start: { side: 'LEFT', line: 7 },
    body: 'Keep this?',
  };

  test('checks the head on GitHub and posts the exact side and range', async () => {
    const { gh, github } = recorded([
      ['api user', { stdout: 'reviewer' }],
      ['--paginate', { json: [[]] }],
      ['api repos/octo/project/pulls/7', { json: { head: { sha: 'reviewed-head' } } }],
      ['--method POST', { json: {} }],
    ]);
    const post = {
      repo: REPO,
      number: 7,
      head: 'reviewed-head',
      submission: 'op-1',
      reconcileOnly: false,
    };

    expect(await github.postComment({ ...post, comment: left })).toEqual({ ok: true, data: null });
    const sent = fields(gh.calls().find((c) => c.argv.includes('POST'))?.stdin ?? '{}');
    const { body, ...rest } = sent;

    expect(String(body)).toMatch(/^Keep this\?\n\n<!-- vimstorm:comment:[0-9a-f]{14} -->$/);
    expect(rest).toEqual({
      commit_id: 'reviewed-head',
      path: 'deleted.rs',
      line: 9,
      side: 'LEFT',
      start_line: 7,
      start_side: 'LEFT',
    });
    gh.answer([
      ['api user', { stdout: 'reviewer' }],
      ['--paginate', { json: [[]] }],
      ['api repos/octo/project/pulls/7', { json: { head: { sha: 'newer-head' } } }],
    ]);
    const before = gh.calls().length;

    expect(
      await github.postComment({
        ...post,
        comment: { path: 'f.rs', line: 1, side: 'RIGHT', body: 'Stale' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(
      gh
        .calls()
        .slice(before)
        .some((c) => c.argv.includes('POST')),
    ).toBe(false);
  });

  test('accepted with its answer lost: read back, never posted twice; tried and not seen: never again', async () => {
    const fake = scripted(`#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path('{dir}')
args = sys.argv[1:]
with (root / 'calls').open('a') as log:
    log.write(' '.join(args) + '\\n')
if args[:2] == ['api', 'user']:
    print('reviewer')
elif '--paginate' in args:
    state = root / 'posted'
    print(state.read_text() if state.exists() else '[[]]')
elif '--method' in args:
    sent = json.load(sys.stdin)
    c = dict(sent, user={'login':'reviewer'}, original_commit_id=sent['commit_id'],
        original_line=sent['line'], original_start_line=sent.get('start_line'))
    (root / 'posted').write_text(json.dumps([[c]]))
    print('error connecting: response lost', file=sys.stderr)
    sys.exit(1)
else:
    print(json.dumps({'head':{'sha':'reviewed-head'}}))
`);
    const post = {
      repo: REPO,
      number: 7,
      head: 'reviewed-head',
      submission: 'op-1',
      comment: {
        path: 'file.rs',
        line: 11,
        side: 'RIGHT',
        body: 'Retain this reasoning',
      } satisfies ReviewComment,
    };

    expect((await fake.github.postComment({ ...post, reconcileOnly: false })).ok).toBe(true);
    expect((await fake.github.postComment({ ...post, reconcileOnly: true })).ok).toBe(true);
    expect(fake.posts()).toBe(1);
    const { gh, github } = recorded([
      ['api user', { stdout: 'reviewer' }],
      ['--paginate', { json: [[]] }],
    ]);

    expect(
      await github.postComment({ ...post, submission: 'attempted', reconcileOnly: true }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(gh.calls().some((c) => c.argv.includes('POST'))).toBe(false);
  });
});

describe("GitHub's file list", () => {
  test("a PR's files come from every page with their patches", async () => {
    const pages: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, 'fixtures', 'review', 'pr-files.json'), 'utf8'),
    );
    const { gh, github } = recorded([['/files', { json: pages }]]);
    const files = await github.prFiles('o/r', 412);

    expect(gh.calls().map((c) => c.argv.join(' '))).toEqual([
      'api --paginate --slurp repos/o/r/pulls/412/files?per_page=100',
    ]);
    if (!files.ok) throw new Error(files.error.message);
    expect(
      files.data.map((f) => [f.status, f.path, f.previous, f.additions, f.deletions, f.binary]),
    ).toEqual([
      ['M', 'src/site.ts', undefined, 2, 1, false],
      ['R', 'src/new.ts', 'src/old.ts', 0, 0, false],
      ['A', 'logo.png', undefined, 0, 0, false],
      ['D', 'big.bin', undefined, 0, 40, true],
    ]);
    expect(files.data[0]?.patch).toBe('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d');
  });
});

describe('a review', () => {
  const review = (more: Partial<ReviewOut> = {}): ReviewOut => ({
    pr: 7,
    commit: 'c0ffee',
    submission: 'review-claim-1',
    reconcileOnly: false,
    verdict: 'Comment',
    body: 'Keep the guard',
    comments: [],
    ...more,
  });
  /** A provider that takes a POST, keeps its JSON and loses the answer; readback rebuilds it. */
  const accepting = () =>
    scripted(`#!/bin/sh
printf '%s\\n' "$*" >> '{dir}/calls'
case "$*" in
  *'api user'*) echo ada;;
  *'--method POST'*)
    cat > '{dir}/posted'
    echo 'error connecting: response lost' >&2
    exit 1;;
  *'/reviews/81/comments?'*)
    if [ -f '{dir}/comments' ]; then cat '{dir}/comments'; else echo '[[]]'; fi;;
  *'/reviews?'*)
    if [ -f '{dir}/posted' ]; then
      printf '[['
      sed 's/^{/{"id":81,"user":{"login":"ada"},"state":"COMMENTED","submitted_at":"2026-10-21T12:00:00Z",/' '{dir}/posted'
      printf ']]\\n'
    else echo '[[]]'; fi;;
  *'pulls/7'*) echo '{"head":{"sha":"c0ffee"}}';;
  *) echo 'HTTP 404' >&2; exit 1;;
esac
`);

  test('one REST payload with its comments on the head read, the body marked', async () => {
    const { gh, github } = recorded([
      ['api user', { stdout: 'ada' }],
      ['reviews?per_page=100', { json: [[]] }],
      ['api repos/o/r/pulls/7', { json: { head: { sha: 'c0ffee' } } }],
      ['--method POST', { json: {} }],
    ]);

    expect(
      await github.submit(
        'o/r',
        review({
          verdict: 'RequestChanges',
          body: 'Fix the guard',
          comments: [
            {
              path: 'src/a.ts',
              line: 12,
              side: 'RIGHT',
              start: { side: 'RIGHT', line: 10 },
              body: 'why?',
            },
            { path: 'src/b.ts', line: 3, side: 'LEFT', body: 'gone?' },
          ],
        }),
      ),
    ).toEqual({ ok: true, data: null });
    expect(gh.calls().map((c) => c.argv.join(' '))).toEqual([
      'api user --jq .login',
      'api --paginate --slurp repos/o/r/pulls/7/reviews?per_page=100',
      'api repos/o/r/pulls/7',
      'api --method POST repos/o/r/pulls/7/reviews --input -',
    ]);
    const { body, ...rest } = fields(gh.calls().at(-1)?.stdin ?? '{}');

    expect(String(body)).toMatch(/^Fix the guard\n\n<!-- vimstorm-review-v1:/);
    expect(rest).toEqual({
      commit_id: 'c0ffee',
      event: 'REQUEST_CHANGES',
      comments: [
        {
          path: 'src/a.ts',
          line: 12,
          side: 'RIGHT',
          start_line: 10,
          start_side: 'RIGHT',
          body: 'why?',
        },
        { path: 'src/b.ts', line: 3, side: 'LEFT', body: 'gone?' },
      ],
    });
  });

  test('a lost answer is read back; a retry posts no second review', async () => {
    const fake = accepting();

    expect((await fake.github.submit('o/r', review())).ok).toBe(true);
    expect(fake.posts()).toBe(1);
    expect((await fake.github.submit('o/r', review())).ok).toBe(true);
    expect(fake.posts()).toBe(1);
  });

  test('its inline comments not confirmed: the first failure kept, a retry only reconciles', async () => {
    const fake = accepting();
    const withComment = review({
      comments: [{ path: 'src/guard.rs', line: 12, side: 'RIGHT', body: 'Preserve this guard' }],
    });

    expect(await fake.github.submit('o/r', withComment)).toMatchObject({
      ok: false,
      error: { code: 'offline' },
    });
    expect(await fake.github.submit('o/r', { ...withComment, reconcileOnly: true })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(fake.posts()).toBe(1);
    writeFileSync(
      join(fake.dir, 'comments'),
      JSON.stringify([
        [],
        [
          {
            id: 99,
            user: { login: 'ada' },
            path: 'src/guard.rs',
            line: null,
            original_line: 12,
            side: 'RIGHT',
            start_line: null,
            body: 'Preserve this guard',
            original_commit_id: 'c0ffee',
          },
        ],
      ]),
    );
    expect((await fake.github.submit('o/r', { ...withComment, reconcileOnly: true })).ok).toBe(
      true,
    );
    expect(fake.posts()).toBe(1);
  });
});
