/**
 * The PR review's pane as the `review` slot's screen draws it, for the contract's fixtures and the
 * component set's sample (`ReviewPane`). It has three states: PR 7 read with a draft, a discussion,
 * three commits and checks, the cursor on a file; the read under way; none under review.
 */
import { type Node, type ReviewPaneNode, reviewScreen, type ReviewState, step } from '@abe/ui';
import { changed, reviewShow } from '../in-process/review';

const sized = (path: string, lines: number) =>
  changed(
    path,
    `@@ -3,${lines} +3,${lines} @@\n${Array.from({ length: lines }, (_, i) => `-a${i}\n+b${i}\n`).join('')}`,
    { additions: lines, deletions: lines },
  );

const SIZE = { width: 600, height: 400 };

const opened = (): { state: ReviewState; id: string } => {
  const open = step(reviewScreen, reviewScreen.init, {
    kind: 'open',
    params: { pr: '7', path: '/work/shop-pr-7', list: 'folder' },
    size: SIZE,
  });
  const run = open.commands[0];

  return { state: open.state, id: run?.kind === 'run' ? run.id : '' };
};

const read = (): ReviewState => {
  const { state, id } = opened();
  const head = 'c0ffee1234';
  const show = reviewShow({
    files: [
      sized('src/cart.ts', 6),
      sized('src/total.ts', 2),
      changed('package-lock.json', '@@ -1 +1 @@\n-a\n+b'),
    ],
    commits: [
      {
        sha: 'aaaa1111',
        subject: 'Add the client',
        author: 'Ada',
        date: '2026-10-20T09:00:00Z',
        files: [
          {
            path: 'src/cart.ts',
            additions: 6,
            deletions: 6,
            binary: false,
            patch: '@@ -3,6 +3,6 @@\n-a\n+b',
          },
        ],
      },
    ],
    drafts: {
      at: 1,
      drafts: [
        {
          seq: 1,
          path: 'src/total.ts',
          line: { side: 'RIGHT', line: 3 },
          body: 'Guard this?',
          head,
        },
      ],
      review: { head, verdict: 'Comment', body: 'A few notes' },
    },
    threads: [
      {
        id: 'T1',
        path: 'src/cart.ts',
        side: 'RIGHT',
        line: 4,
        start: null,
        head,
        outdated: false,
        resolved: false,
        canReply: true,
        canResolve: true,
        comments: [
          {
            id: 90,
            author: 'bob',
            body: 'Why this?',
            url: 'https://github.com/acme/shop/pull/7#discussion_r90',
          },
        ],
      },
    ],
    pr: {
      checks: { total: 2, passed: 1, failed: 0, failing: [], running: true },
      decision: 'required',
    },
  });

  return step(reviewScreen, state, {
    kind: 'result',
    id,
    command: 'review show',
    reply: { ok: true, data: show },
  }).state;
};

/** Each state's tree, by its fixture name. */
export const reviewTrees = (): Record<string, Node> => ({
  'review-pane': reviewScreen.view(step(reviewScreen, read(), { kind: 'key', key: 'ö' }).state),
  'review-reading': reviewScreen.view(opened().state),
  'review-none': reviewScreen.view(reviewScreen.init),
});

/** The read pane, with every prop the component set's sample checks. */
export const reviewPaneSample = (): ReviewPaneNode => {
  const tree = reviewScreen.view(read());

  if (tree.kind !== 'ReviewPane') throw new Error('no ReviewPane');

  return tree;
};
