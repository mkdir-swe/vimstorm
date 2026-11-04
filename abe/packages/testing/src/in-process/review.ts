/**
 * A `ReviewPort` held in memory for scenarios. It holds a PR's checkout (its files against the
 * merge base, commits, package folders), GitHub's side (the PR, who you are, discussions) and the
 * docs. It records the writes in order, and the test sets GitHub's answers to them.
 */
import {
  type ChangedFile,
  type DraftPrPlan,
  type Drafts,
  type Marks,
  NO_DRAFTS,
  type OpenPr,
  type RangeCommit,
  type ReviewAnswer,
  type ReviewError,
  type ReviewOut,
  type ReviewPort,
  type ReviewPr,
  readChanges,
  type ReviewShowData,
  type ReviewWorktree,
  type Thread,
} from '@abe/core';

export type ReviewWrite =
  | { kind: 'submit'; review: ReviewOut }
  | {
      kind: 'post';
      head: string;
      submission: string;
      reconcileOnly: boolean;
      path: string;
      line: number;
      body: string;
    }
  | { kind: 'reply'; commentId: number; submission: string; reconcileOnly: boolean; body: string }
  | { kind: 'resolve'; thread: string; resolved: boolean }
  | { kind: 'ready' }
  | { kind: 'close' }
  | { kind: 'say'; body: string }
  | { kind: 'checkout'; path: string; branch: string; reuse: boolean; upstream?: string }
  | { kind: 'draft'; title: string; base: string; push: boolean }
  | { kind: 'reviewers'; logins: readonly string[] };

export type FakeReview = ReviewPort & {
  /** What the test sets: the checkout, GitHub and their answers. */
  repo: string;
  main: string;
  base: string;
  head: string;
  files: ChangedFile[];
  history: RangeCommit[];
  packagesIn: string[];
  github: ReviewPr;
  login: string | null;
  open: OpenPr[];
  discussions: Thread[] | ReviewError;
  trees: ReviewWorktree[];
  plan: DraftPrPlan | ReviewError;
  /** GitHub's answer to the next writes (a review, a comment posted now, a reply), oldest first. */
  answers: ReviewAnswer<null>[];
  checkout: ReviewAnswer<{ path: string; head: string }> | undefined;
  docs: Map<string, Drafts>;
  markDocs: Map<string, Marks>;
  writes: ReviewWrite[];
};

const ok = <T>(data: T): ReviewAnswer<T> => ({ ok: true, data });

export const reviewPr = (more: Partial<ReviewPr> = {}): ReviewPr => ({
  repo: 'acme/shop',
  number: 7,
  title: 'Cart totals',
  url: 'https://github.com/acme/shop/pull/7',
  author: 'bob',
  branch: 'feature/cart',
  base: 'main',
  body: 'What it does',
  state: 'open',
  draft: false,
  head: 'head111',
  decision: null,
  mergeable: 'mergeable',
  mergeState: 'clean',
  checks: { total: 0, passed: 0, failed: 0, failing: [], running: false },
  ...more,
});

export const changed = (
  path: string,
  patch: string,
  more: Partial<ChangedFile> = {},
): ChangedFile => ({
  path,
  status: 'M',
  additions: 1,
  deletions: 1,
  binary: false,
  patch,
  ...more,
});

export const fakeReview = (more: Partial<FakeReview> = {}): FakeReview => {
  const f: FakeReview = {
    repo: 'acme/shop',
    main: '/work/shop',
    base: 'base000',
    head: 'head111',
    files: [],
    history: [],
    packagesIn: [],
    github: reviewPr(),
    login: 'ada',
    open: [],
    discussions: [],
    trees: [{ path: '/work/shop', branch: 'main' }],
    plan: { code: 'invalid', message: 'This checkout has no GitHub repository' },
    answers: [],
    checkout: undefined,
    docs: new Map(),
    markDocs: new Map(),
    writes: [],
    mainOf: () => Promise.resolve(ok(f.main)),
    repoOf: () => Promise.resolve(ok(f.repo)),
    changes: () => Promise.resolve(ok({ base: f.base, head: f.head, files: f.files })),
    commits: (_path, from) =>
      Promise.resolve(
        from === f.base || f.history.some((c) => c.sha === from)
          ? ok(f.history.slice(f.history.findIndex((c) => c.sha === from) + 1))
          : {
              ok: false,
              error: {
                code: 'not-found',
                message: `git: ${from.slice(0, 7)} is not in the checkout`,
              },
            },
      ),
    packages: () => Promise.resolve(ok(f.packagesIn)),
    worktrees: () => Promise.resolve(ok(f.trees)),
    checkoutPr: (input) => {
      f.writes.push({
        kind: 'checkout',
        path: input.path,
        branch: input.branch,
        reuse: input.reuse,
        ...(input.upstream === undefined ? {} : { upstream: input.upstream.ref }),
      });

      return Promise.resolve(f.checkout ?? ok({ path: input.path, head: f.head }));
    },
    me: () =>
      Promise.resolve(
        f.login === null
          ? { ok: false, error: { code: 'auth', message: 'gh auth login' } }
          : ok(f.login),
      ),
    pr: () => Promise.resolve(ok(f.github)),
    prs: () => Promise.resolve(ok(f.open)),
    prFiles: () => Promise.resolve(ok(f.files)),
    threads: () =>
      Promise.resolve(
        Array.isArray(f.discussions) ? ok(f.discussions) : { ok: false, error: f.discussions },
      ),
    submit: (_repo, review) => {
      f.writes.push({ kind: 'submit', review });

      return Promise.resolve(f.answers.shift() ?? ok(null));
    },
    postComment: (input) => {
      f.writes.push({
        kind: 'post',
        head: input.head,
        submission: input.submission,
        reconcileOnly: input.reconcileOnly,
        path: input.comment.path,
        line: input.comment.line,
        body: input.comment.body,
      });

      return Promise.resolve(f.answers.shift() ?? ok(null));
    },
    reply: (input) => {
      f.writes.push({
        kind: 'reply',
        commentId: input.commentId,
        submission: input.submission,
        reconcileOnly: input.reconcileOnly,
        body: input.body,
      });

      return Promise.resolve(f.answers.shift() ?? ok(null));
    },
    resolve: (thread, resolved) => {
      f.writes.push({ kind: 'resolve', thread, resolved });

      return Promise.resolve(ok(null));
    },
    ready: () => {
      f.writes.push({ kind: 'ready' });

      return Promise.resolve(ok(null));
    },
    close: () => {
      f.writes.push({ kind: 'close' });

      return Promise.resolve(ok(null));
    },
    say: (_repo, _number, body) => {
      f.writes.push({ kind: 'say', body });

      return Promise.resolve(f.answers.shift() ?? ok(null));
    },
    draftPlan: () => Promise.resolve('root' in f.plan ? ok(f.plan) : { ok: false, error: f.plan }),
    draftCreate: (input) => {
      f.writes.push({ kind: 'draft', title: input.title, base: input.base, push: input.push });

      return Promise.resolve(ok({ number: 31, url: 'https://github.com/acme/shop/pull/31' }));
    },
    requestReviewers: (_repo, _n, logins) => {
      f.writes.push({ kind: 'reviewers', logins });

      return Promise.resolve(ok(null));
    },
    marks: (main, pr) => Promise.resolve(ok(f.markDocs.get(`${main}#${pr}`) ?? null)),
    putMarks: (main, pr, marks) => {
      f.markDocs.set(`${main}#${pr}`, marks);

      return Promise.resolve(ok(null));
    },
    drafts: (main, pr) => Promise.resolve(ok(f.docs.get(`${main}#${pr}`) ?? NO_DRAFTS)),
    putDrafts: (main, pr, drafts) => {
      f.docs.set(`${main}#${pr}`, drafts);

      return Promise.resolve(ok(null));
    },
    ...more,
  };

  return f;
};

/** `abe review show`'s answer for PR 7 in `path`, read from `files` (and `commits`) on `head`. */
export const reviewShow = (
  o: {
    path?: string;
    files?: ChangedFile[];
    commits?: RangeCommit[];
    marks?: Marks | null;
    drafts?: Drafts;
    threads?: Thread[] | null;
    pr?: Partial<ReviewPr>;
    me?: string | null;
    unchecked?: string | null;
    base?: string;
    head?: string;
    packages?: string[];
  } = {},
): ReviewShowData => {
  const head = o.head ?? 'c0ffee1234';
  const checked = o.unchecked === undefined || o.unchecked === null;
  const path = o.path ?? '/work/shop-pr-7';

  return {
    repo: 'acme/shop',
    number: 7,
    path,
    main: '/work/shop',
    pr: reviewPr({ head, ...o.pr }),
    me: o.me === undefined ? 'ada' : o.me,
    unchecked: o.unchecked ?? null,
    read: readChanges({
      head,
      base: checked ? (o.base ?? 'base000') : null,
      worktree: checked ? path : null,
      files: o.files ?? [],
      commits: o.commits ?? [],
      fresh: [],
      marks: o.marks ?? null,
      packages: o.packages ?? [],
    }),
    marks: o.marks ?? null,
    drafts: o.drafts ?? NO_DRAFTS,
    threads: o.threads === undefined ? [] : o.threads,
    threadsError: o.threads === null ? 'Review permission denied' : null,
  };
};
