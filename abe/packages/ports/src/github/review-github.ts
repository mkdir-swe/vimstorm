/**
 * The review's GitHub, as the person (`gh` on its own login): the PR and its checks, its
 * discussions (GraphQL, each connection paged on its own), a review, a comment posted now and a
 * reply, each marked with its submission and read back after an uncertain write, so a retry only
 * reconciles and nothing is posted twice.
 */
import { z } from 'zod';
import {
  type ChangedFile,
  type ConversationItem,
  hash,
  type OpenPr,
  type ReviewAnswer,
  type ReviewComment,
  type ReviewErrorCode,
  type ReviewOut,
  type ReviewPr,
  stableJson,
  type Thread,
  VERDICT_EVENT,
} from '@abe/core';
import { type Gh } from './gh';

/** gh's words and what they mean, the first that matches winning (1.x's `failure`). */
const FAILURES: readonly (readonly [ReviewErrorCode, readonly string[]])[] = [
  ['auth', ['http 401', 'bad credentials', 'gh auth login', 'not logged in', 'authentication']],
  [
    'not-found',
    [
      'http 404',
      'not found',
      'could not find',
      'could not resolve to a',
      'no pull requests found',
      'no pull request found',
    ],
  ],
  ['conflict', ['http 409', 'conflict', 'not mergeable']],
  ['invalid', ['http 422', 'validation failed', 'unprocessable']],
  ['refused', ['http 403', 'forbidden', 'not accessible', 'permission']],
  [
    'offline',
    ['error connecting', 'could not resolve host', 'network is unreachable', 'connection refused'],
  ],
];

/** What gh's failure means: its first line, by the words in it. */
export const reviewFailure = (stderr: string): { code: ReviewErrorCode; message: string } => {
  const first = stderr.trim().split('\n')[0]?.trim() ?? '';
  const lower = first.toLowerCase();
  const code = FAILURES.find(([, words]) => words.some((w) => lower.includes(w)))?.[0] ?? 'failed';

  return { code, message: first.startsWith('gh') ? first : `gh: ${first}` };
};

const fail = (code: ReviewErrorCode, message: string) =>
  ({ ok: false, error: { code, message } }) as const;

const FAILED = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'];

type Outcome = 'success' | 'failure' | 'running';

const outcomeOf = (status: string, conclusion: string): Outcome => {
  if (FAILED.includes(conclusion)) return 'failure';

  return status !== 'COMPLETED' || conclusion === 'PENDING' || conclusion === 'EXPECTED'
    ? 'running'
    : 'success';
};

const STATES: Readonly<Record<string, ReviewPr['state']>> = { MERGED: 'merged', CLOSED: 'closed' };
const DECISIONS: Readonly<Record<string, ReviewPr['decision']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  REVIEW_REQUIRED: 'required',
};
const MERGEABLE: Readonly<Record<string, ReviewPr['mergeable']>> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
};
const FILE_STATUS: Readonly<Record<string, ChangedFile['status']>> = {
  added: 'A',
  copied: 'A',
  removed: 'D',
  renamed: 'R',
};

/** `table[key]`, or `fallback` for a key it has not. */
const pick = <T>(table: Readonly<Record<string, T>>, key: string, fallback: T): T =>
  Object.hasOwn(table, key) ? (table[key] ?? fallback) : fallback;

const Check = z.looseObject({
  __typename: z.string().optional(),
  name: z.string().nullish(),
  context: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
});

const checkOf = (c: z.infer<typeof Check>): { name: string; outcome: Outcome } =>
  c.__typename === 'StatusContext'
    ? { name: c.context ?? '', outcome: outcomeOf('COMPLETED', (c.state ?? '').toUpperCase()) }
    : {
        name: c.name ?? '',
        outcome: outcomeOf((c.status ?? '').toUpperCase(), (c.conclusion ?? '').toUpperCase()),
      };

const Login = z.looseObject({ login: z.string().nullish() }).nullish();

const PrView = z.looseObject({
  number: z.number().int(),
  title: z.string(),
  url: z.string().nullish(),
  author: Login,
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string().nullish(),
  body: z.string().nullish(),
  state: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(Check).nullish(),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  updatedAt: z.string().nullish(),
  isCrossRepository: z.boolean().nullish(),
  headRepositoryOwner: Login,
  headRepository: z.looseObject({ name: z.string().nullish() }).nullish(),
  comments: z
    .array(
      z.looseObject({ author: Login, body: z.string().nullish(), createdAt: z.string().nullish() }),
    )
    .nullish(),
  reviews: z
    .array(
      z.looseObject({
        author: Login,
        body: z.string().nullish(),
        state: z.string().nullish(),
        submittedAt: z.string().nullish(),
      }),
    )
    .nullish(),
});

const REVIEW_KIND: Readonly<Record<string, ConversationItem['kind']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** The comments and the reviews with a verdict or a summary, oldest first. */
const conversationOf = (v: z.infer<typeof PrView>): ConversationItem[] | undefined => {
  if ((v.comments ?? null) === null && (v.reviews ?? null) === null) return undefined;
  const comments = (v.comments ?? []).map((c): ConversationItem => ({
    kind: 'comment',
    author: c.author?.login ?? '',
    body: c.body ?? '',
    at: c.createdAt ?? '',
  }));
  const reviews = (v.reviews ?? []).flatMap((r): ConversationItem[] => {
    const kind = REVIEW_KIND[(r.state ?? '').toUpperCase()];
    const body = (r.body ?? '').trim();

    // a pending review, or one that only wraps line comments
    if (kind === undefined || (kind === 'commented' && body === '')) return [];

    return [{ kind, author: r.author?.login ?? '', body, at: r.submittedAt ?? '' }];
  });

  return [...comments, ...reviews].sort((a, b) => a.at.localeCompare(b.at));
};

export const PR_VIEW_FIELDS =
  'number,title,url,author,headRefName,headRefOid,baseRefName,body,state,isDraft,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,updatedAt,isCrossRepository,headRepositoryOwner,headRepository,comments,reviews';

/** `gh pr view --json` as the review reads a PR. */
export const reviewPrOf = (repo: string, v: z.infer<typeof PrView>): ReviewPr => {
  const checks = (v.statusCheckRollup ?? []).map(checkOf);
  const state = (v.state ?? '').toUpperCase();
  const decision = v.reviewDecision ?? '';
  const conversation = conversationOf(v);
  const owner = v.headRepositoryOwner?.login ?? '';
  const name = v.headRepository?.name ?? '';
  const fork =
    v.isCrossRepository === true && owner !== '' && name !== '' ? `${owner}/${name}` : undefined;

  return {
    repo,
    number: v.number,
    title: v.title,
    url: v.url ?? '',
    author: v.author?.login ?? '',
    branch: v.headRefName,
    base: v.baseRefName ?? '',
    body: v.body ?? '',
    state: pick(STATES, state, 'open'),
    draft: v.isDraft === true,
    head: v.headRefOid,
    decision: pick(DECISIONS, decision, null),
    mergeable: pick(MERGEABLE, v.mergeable ?? '', 'unknown'),
    mergeState: (v.mergeStateStatus ?? '').toLowerCase() || 'unknown',
    checks: {
      total: checks.length,
      passed: checks.filter((c) => c.outcome === 'success').length,
      failed: checks.filter((c) => c.outcome === 'failure').length,
      failing: checks.filter((c) => c.outcome === 'failure').map((c) => c.name),
      running: checks.some((c) => c.outcome === 'running'),
    },
    ...(v.updatedAt === null || v.updatedAt === undefined ? {} : { updatedAt: v.updatedAt }),
    ...(conversation === undefined ? {} : { conversation }),
    ...(fork === undefined ? {} : { fork }),
  };
};

const PrListed = z.looseObject({
  number: z.number().int(),
  title: z.string(),
  author: Login,
  headRefName: z.string(),
  isDraft: z.boolean().nullish(),
  reviewRequests: z
    .array(
      z.looseObject({
        login: z.string().nullish(),
        slug: z.string().nullish(),
        name: z.string().nullish(),
      }),
    )
    .nullish(),
});

const PrFile = z.looseObject({
  filename: z.string(),
  previous_filename: z.string().nullish(),
  status: z.string().nullish(),
  additions: z.number().int().nullish(),
  deletions: z.number().int().nullish(),
  patch: z.string().nullish(),
});

const Person = z.looseObject({ login: z.string(), name: z.string().nullish() });

const THREADS = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path diffSide line startLine originalLine originalStartLine isOutdated isResolved
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId: fullDatabaseId author { login } body url originalCommit { oid } pullRequestReview { state } }
          }
        }
      }
    }
  }
}`;

const COMMENTS = `query ReviewThreadComments($thread: ID!, $cursor: String) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId: fullDatabaseId author { login } body url originalCommit { oid } pullRequestReview { state } }
      }
    }
  }
}`;

const Page = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

const ThreadComment = z.looseObject({
  databaseId: z.union([z.number(), z.string()]),
  author: Login,
  body: z.string(),
  url: z.string(),
  originalCommit: z.looseObject({ oid: z.string() }).nullish(),
  pullRequestReview: z.looseObject({ state: z.string() }).nullish(),
});
type ThreadComment = z.infer<typeof ThreadComment>;

const Comments = z.object({ nodes: z.array(ThreadComment), pageInfo: Page });

const Discussion = z.looseObject({
  id: z.string(),
  path: z.string(),
  diffSide: z.enum(['LEFT', 'RIGHT']),
  line: z.number().int().nullish(),
  startLine: z.number().int().nullish(),
  originalLine: z.number().int().nullish(),
  originalStartLine: z.number().int().nullish(),
  isOutdated: z.boolean(),
  isResolved: z.boolean(),
  viewerCanReply: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  comments: Comments,
});

const ThreadsPage = z.object({
  repository: z.object({
    pullRequest: z.object({
      headRefOid: z.string().min(1),
      reviewThreads: z.object({ nodes: z.array(Discussion), pageInfo: Page }),
    }),
  }),
});

const RestComment = z.looseObject({
  id: z.number().int().optional(),
  user: z.looseObject({ login: z.string() }).nullish(),
  body: z.string().nullish(),
  path: z.string().nullish(),
  side: z.string().nullish(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  start_line: z.number().nullish(),
  original_start_line: z.number().nullish(),
  start_side: z.string().nullish(),
  original_commit_id: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
});
type RestComment = z.infer<typeof RestComment>;

const RestReview = z.looseObject({
  id: z.number().int().optional(),
  user: z.looseObject({ login: z.string() }).nullish(),
  body: z.string().nullish(),
  commit_id: z.string().nullish(),
  submitted_at: z.string().nullish(),
  state: z.string().nullish(),
});

const sides = (c: ReviewComment) => ({
  path: c.path,
  line: c.line,
  side: c.side,
  body: c.body,
  ...(c.start === undefined ? {} : { start_line: c.start.line, start_side: c.start.side }),
});

export type ReviewGithub = {
  me: () => Promise<ReviewAnswer<string>>;
  pr: (repo: string, number: number) => Promise<ReviewAnswer<ReviewPr>>;
  prs: (repo: string) => Promise<ReviewAnswer<OpenPr[]>>;
  prFiles: (repo: string, number: number) => Promise<ReviewAnswer<ChangedFile[]>>;
  threads: (repo: string, number: number) => Promise<ReviewAnswer<Thread[]>>;
  submit: (repo: string, review: ReviewOut) => Promise<ReviewAnswer<null>>;
  postComment: (input: {
    repo: string;
    number: number;
    head: string;
    submission: string;
    reconcileOnly: boolean;
    comment: ReviewComment;
  }) => Promise<ReviewAnswer<null>>;
  reply: (input: {
    repo: string;
    number: number;
    commentId: number;
    submission: string;
    reconcileOnly: boolean;
    body: string;
  }) => Promise<ReviewAnswer<null>>;
  resolve: (thread: string, resolved: boolean) => Promise<ReviewAnswer<null>>;
  ready: (repo: string, number: number) => Promise<ReviewAnswer<null>>;
  close: (repo: string, number: number) => Promise<ReviewAnswer<null>>;
  say: (repo: string, number: number, body: string) => Promise<ReviewAnswer<null>>;
  defaultBranch: (repo: string) => Promise<ReviewAnswer<string>>;
  openPrOn: (
    repo: string,
    branch: string,
  ) => Promise<ReviewAnswer<{ number: number; url: string } | null>>;
  createDraft: (input: {
    repo: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<ReviewAnswer<{ number: number; url: string }>>;
  people: (repo: string) => Promise<ReviewAnswer<{ login: string; name: string }[]>>;
  requestReviewers: (
    repo: string,
    number: number,
    logins: readonly string[],
  ) => Promise<ReviewAnswer<null>>;
};

export const reviewGithub = (gh: Gh): ReviewGithub => {
  const run = async (args: readonly string[], stdin?: string): Promise<ReviewAnswer<string>> => {
    const r = await gh(args, stdin);

    if (r.ok) return { ok: true, data: r.stdout };
    const f = reviewFailure(r.error.message);

    return { ok: false, error: f };
  };
  const json = async <T extends z.ZodType>(
    schema: T,
    args: readonly string[],
    what: string,
  ): Promise<ReviewAnswer<z.output<T>>> => {
    const r = await run(args);

    if (!r.ok) return r;
    let parsed: unknown;

    try {
      parsed = JSON.parse(r.data);
    } catch {
      return fail('failed', `${what}: unexpected answer: no JSON`);
    }
    const checked = schema.safeParse(parsed);

    return checked.success
      ? { ok: true, data: checked.data }
      : fail(
          'failed',
          `${what}: unexpected answer: ${checked.error.issues[0]?.message ?? 'a shape Abe does not read'}`,
        );
  };
  /** Every page of a REST list (`--paginate --slurp`), flattened. */
  const pages = async <T extends z.ZodType>(item: T, path: string, what: string) => {
    const r = await json(z.array(z.array(item)), ['api', '--paginate', '--slurp', path], what);

    return r.ok ? { ok: true as const, data: r.data.flat() } : r;
  };
  const send = async (method: string, path: string, body: unknown) =>
    run(['api', '--method', method, path, '--input', '-'], JSON.stringify(body));
  const done = (r: ReviewAnswer<unknown>): ReviewAnswer<null> =>
    r.ok ? { ok: true, data: null } : r;

  const me = async (): Promise<ReviewAnswer<string>> => {
    const r = await run(['api', 'user', '--jq', '.login']);

    return r.ok ? { ok: true, data: r.data.trim() } : r;
  };

  const graphql = async (query: string, vars: Readonly<Record<string, string | number>>) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];

    for (const [name, value] of Object.entries(vars))
      args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
    const r = await json(
      z.looseObject({ data: z.unknown().optional(), errors: z.unknown().optional() }),
      args,
      'gh review threads',
    );

    if (!r.ok) return r;
    const errors = r.data.errors;

    if (
      errors !== undefined &&
      errors !== null &&
      !(Array.isArray(errors) && errors.length === 0)
    ) {
      const text = JSON.stringify(errors);
      const f = reviewFailure(text);

      return fail(text.includes('FORBIDDEN') ? 'refused' : f.code, f.message);
    }
    if (r.data.data === undefined || r.data.data === null)
      return fail('failed', 'gh review threads: missing data');

    return { ok: true as const, data: r.data.data };
  };

  const nextCursor = (page: z.infer<typeof Page>, seen: Set<string>) => {
    if (!page.hasNextPage) return { ok: true as const, data: null };
    const c = page.endCursor ?? '';

    if (c === '' || seen.has(c))
      return fail('failed', 'gh review threads: pagination did not advance');
    seen.add(c);

    return { ok: true as const, data: c };
  };

  const threadOf = async (
    d: z.infer<typeof Discussion>,
    currentHead: string,
  ): Promise<ReviewAnswer<Thread>> => {
    const comments: ThreadComment[] = [...d.comments.nodes];
    const seen = new Set<string>();
    let cursor = nextCursor(d.comments.pageInfo, seen);

    while (cursor.ok && cursor.data !== null) {
      const got = await graphql(COMMENTS, { thread: d.id, cursor: cursor.data });

      if (!got.ok) return got;
      const page = z.object({ node: z.object({ comments: Comments }) }).safeParse(got.data);

      if (!page.success) return fail('failed', 'gh review threads: incomplete connection answer');
      comments.push(...page.data.node.comments.nodes);
      cursor = nextCursor(page.data.node.comments.pageInfo, seen);
    }
    if (!cursor.ok) return cursor;
    const kept = comments.filter((c) => c.pullRequestReview?.state !== 'PENDING');

    return {
      ok: true,
      data: {
        id: d.id,
        path: d.path,
        side: d.diffSide,
        line: (d.isOutdated ? d.originalLine : d.line) ?? null,
        start: (d.isOutdated ? d.originalStartLine : d.startLine) ?? null,
        head: d.isOutdated ? (kept[0]?.originalCommit?.oid ?? '') : currentHead,
        outdated: d.isOutdated,
        resolved: d.isResolved,
        canReply: d.viewerCanReply,
        canResolve: d.isResolved ? d.viewerCanUnresolve : d.viewerCanResolve,
        comments: kept.map((c) => ({
          id: Number(c.databaseId),
          author: c.author?.login ?? '(deleted)',
          body: c.body,
          url: c.url,
        })),
      },
    };
  };

  const threads = async (repo: string, number: number): Promise<ReviewAnswer<Thread[]>> => {
    const [owner, name] = repo.split('/');

    if (owner === undefined || name === undefined || owner === '' || name === '')
      return fail('invalid', 'GitHub repository must be owner/name');
    const out: Thread[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;

    for (;;) {
      const got = await graphql(THREADS, {
        owner,
        name,
        number,
        ...(cursor === null ? {} : { cursor }),
      });

      if (!got.ok) return got;
      const page = ThreadsPage.safeParse(got.data);

      if (!page.success) return fail('failed', 'gh review threads: incomplete connection answer');
      const pr = page.data.repository.pullRequest;

      for (const d of pr.reviewThreads.nodes) {
        const t = await threadOf(d, pr.headRefOid);

        if (!t.ok) return t;
        if (t.data.comments.length > 0) out.push(t.data);
      }
      const next = nextCursor(pr.reviewThreads.pageInfo, seen);

      if (!next.ok) return next;
      if (next.data === null) return { ok: true, data: out };
      cursor = next.data;
    }
  };

  /** A fresh check right before a revision-bound write (GitHub's review takes no head guard). */
  const requireHead = async (repo: string, number: number, head: string) => {
    if (head === '') return fail('invalid', 'Review revision is missing');
    const current = await json(
      z.looseObject({ head: z.looseObject({ sha: z.string() }) }),
      ['api', `repos/${repo}/pulls/${number}`],
      'gh api pulls',
    );

    if (!current.ok) return current;

    return current.data.head.sha === head
      ? { ok: true as const, data: null }
      : fail('conflict', 'The pull-request head changed; refresh before submitting the review');
  };

  const submitted = async (
    repo: string,
    review: ReviewOut,
    body: { body: string; comments: Record<string, unknown>[] },
    marker: string,
    login: string,
  ): Promise<ReviewAnswer<boolean>> => {
    const posted = await pages(
      RestReview,
      `repos/${repo}/pulls/${review.pr}/reviews?per_page=100`,
      'GitHub review readback',
    );

    if (!posted.ok) return posted;
    const same = (a: string | undefined) => a?.toLowerCase() === login.toLowerCase();

    for (const p of posted.data) {
      if (!same(p.user?.login) || !(p.body ?? '').includes(marker)) continue;
      if (
        p.body !== body.body ||
        p.commit_id !== review.commit ||
        (p.submitted_at ?? '') === '' ||
        p.state === 'PENDING'
      )
        return fail(
          'conflict',
          'This review submission exists on GitHub but changed or is pending; inspect it before retrying. Drafts kept',
        );
      if (body.comments.length > 0) {
        if (p.id === undefined)
          return fail('failed', 'GitHub review readback has no id; drafts kept');
        const comments = await pages(
          RestComment,
          `repos/${repo}/pulls/${review.pr}/reviews/${p.id}/comments?per_page=100`,
          'GitHub review readback',
        );

        if (!comments.ok) return comments;
        const missing = [...body.comments];

        for (const c of comments.data) {
          if (!same(c.user?.login) || (c.in_reply_to_id ?? null) !== null) continue;
          const at = missing.findIndex((w) => sameComment(c, w));

          if (at >= 0) missing.splice(at, 1);
        }
        if (missing.length > 0)
          return fail(
            'conflict',
            'Review found, but its inline comments could not all be confirmed. Drafts kept; refresh GitHub before retrying',
          );
      }

      return { ok: true, data: true };
    }

    return { ok: true, data: false };
  };

  const submit = async (repo: string, review: ReviewOut): Promise<ReviewAnswer<null>> => {
    if (review.submission === '' || review.commit === '')
      return fail('invalid', 'Review submission identity and revision are required; drafts kept');
    const payload = {
      commit_id: review.commit,
      event: VERDICT_EVENT[review.verdict],
      body: review.body ?? '',
      comments: review.comments.map(sides),
    };
    // only what the review holds names it: a retry looks up exactly the same marker
    const key = hash(stableJson({ repo, pr: review.pr, review: payload }));
    const marker = `<!-- vimstorm-review-v1:${hash(review.submission)}:${key} -->`;
    const note = review.body ?? '';
    const body = { ...payload, body: note === '' ? marker : `${note}\n\n${marker}` };
    const login = await me();

    if (!login.ok) return login;
    if (login.data === '') return fail('auth', 'GitHub login is missing');
    const found = await submitted(repo, review, body, marker, login.data);

    if (!found.ok) return found;
    if (found.data) return { ok: true, data: null };
    if (review.reconcileOnly)
      return fail(
        'conflict',
        'No posted review could be confirmed for this submission. Drafts kept; inspect GitHub before starting a new review',
      );
    const head = await requireHead(repo, review.pr, review.commit);

    if (!head.ok) return head;
    const sent = await send('POST', `repos/${repo}/pulls/${review.pr}/reviews`, body);

    if (sent.ok) return { ok: true, data: null };
    // the answer may be lost after GitHub took the whole review: read it back
    const after = await submitted(repo, review, body, marker, login.data);

    return after.ok && after.data ? { ok: true, data: null } : sent;
  };

  const postComment: ReviewGithub['postComment'] = async (input) => {
    const { repo, number, head, submission, reconcileOnly, comment } = input;

    if (submission.trim() === '')
      return fail('invalid', 'Immediate comment needs a durable submission identity');
    const payload: Record<string, unknown> = { commit_id: head, ...sides(comment) };
    const key = hash(stableJson([repo, number, submission, payload]));
    const body = { ...payload, body: `${comment.body}\n\n<!-- vimstorm:comment:${key} -->` };
    const login = await me();

    if (!login.ok) return login;
    const posted = async () => {
      const list = await pages(
        RestComment,
        `repos/${repo}/pulls/${number}/comments?per_page=100`,
        'gh posted comments',
      );

      if (!list.ok) return list;

      return {
        ok: true as const,
        data: list.data.some(
          (c) =>
            c.user?.login === login.data &&
            c.original_commit_id === head &&
            c.body === body.body &&
            c.path === comment.path &&
            c.side === comment.side &&
            (c.original_line ?? null) === comment.line &&
            (c.original_start_line ?? null) === (comment.start?.line ?? null) &&
            (c.start_side ?? null) === (comment.start?.side ?? null),
        ),
      };
    };
    const before = await posted();

    if (!before.ok) return before;
    if (before.data) return { ok: true, data: null };
    if (reconcileOnly)
      return fail(
        'conflict',
        'The attempted comment is not visible yet; refresh to reconcile without posting it again',
      );
    const fresh = await requireHead(repo, number, head);

    if (!fresh.ok) return fresh;
    const sent = await send('POST', `repos/${repo}/pulls/${number}/comments`, body);

    if (sent.ok) return { ok: true, data: null };
    if (sent.error.code === 'failed' || sent.error.code === 'offline') {
      const after = await posted();

      if (after.ok && after.data) return { ok: true, data: null };
    }

    return sent;
  };

  const reply: ReviewGithub['reply'] = async (input) => {
    const { repo, number, commentId, submission, reconcileOnly, body } = input;

    if (submission.trim() === '')
      return fail('invalid', 'Reply needs a durable submission identity');
    const key = hash(stableJson([repo, number, commentId, submission, body]));
    const marked = `${body}\n\n<!-- vimstorm:reply:${key} -->`;
    // failures known to come before the send: the claim may be released and tried again
    const preflight = <T>(r: ReviewAnswer<T>): ReviewAnswer<T> =>
      r.ok || reconcileOnly ? r : { ok: false, error: { ...r.error, code: 'precondition' } };
    const login = preflight(await me());

    if (!login.ok) return login;
    const posted = async () => {
      const list = await pages(
        RestComment,
        `repos/${repo}/pulls/${number}/comments?per_page=100`,
        'gh posted replies',
      );

      if (!list.ok) return list;

      return {
        ok: true as const,
        data: list.data.some(
          (c) =>
            c.user?.login === login.data && c.in_reply_to_id === commentId && c.body === marked,
        ),
      };
    };
    const before = preflight(await posted());

    if (!before.ok) return before;
    if (before.data) return { ok: true, data: null };
    if (reconcileOnly)
      return fail(
        'conflict',
        'The attempted reply is not visible yet; refresh to reconcile without posting it again',
      );
    const sent = await send('POST', `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, {
      body: marked,
    });

    if (sent.ok) return { ok: true, data: null };
    if (sent.error.code === 'failed' || sent.error.code === 'offline') {
      const after = await posted();

      if (after.ok && after.data) return { ok: true, data: null };
    }

    return sent;
  };

  return {
    me,
    pr: async (repo, number) => {
      const r = await json(
        PrView,
        ['pr', 'view', String(number), '--repo', repo, '--json', PR_VIEW_FIELDS],
        'gh pr view',
      );

      return r.ok ? { ok: true, data: reviewPrOf(repo, r.data) } : r;
    },
    prs: async (repo) => {
      const r = await json(
        z.array(PrListed),
        [
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--limit',
          '40',
          '--json',
          'number,title,author,headRefName,isDraft,reviewRequests',
        ],
        'gh pr list',
      );

      return r.ok
        ? {
            ok: true,
            data: r.data.map((p) => ({
              number: p.number,
              title: p.title,
              author: p.author?.login ?? '',
              branch: p.headRefName,
              draft: p.isDraft === true,
              requested: (p.reviewRequests ?? [])
                .map((q) => q.login ?? q.slug ?? q.name ?? '')
                .filter((q) => q !== ''),
            })),
          }
        : r;
    },
    prFiles: async (repo, number) => {
      const r = await pages(
        PrFile,
        `repos/${repo}/pulls/${number}/files?per_page=100`,
        'gh api files',
      );

      return r.ok
        ? {
            ok: true,
            data: r.data.map((f): ChangedFile => {
              const additions = f.additions ?? 0;
              const deletions = f.deletions ?? 0;
              const patch = f.patch ?? undefined;

              return {
                path: f.filename,
                ...(f.previous_filename === null || f.previous_filename === undefined
                  ? {}
                  : { previous: f.previous_filename }),
                status: pick(FILE_STATUS, f.status ?? '', 'M'),
                additions,
                deletions,
                binary: patch === undefined && additions + deletions > 0,
                patch: patch ?? '',
              };
            }),
          }
        : r;
    },
    threads,
    submit,
    postComment,
    reply,
    resolve: async (thread, resolved) => {
      const [operation, field] = resolved
        ? ['Resolve', 'resolveReviewThread']
        : ['Unresolve', 'unresolveReviewThread'];
      const got = await graphql(
        `mutation ${operation}($thread: ID!) { ${field}(input: {threadId: $thread}) { thread { id isResolved } } }`,
        { thread },
      );

      if (!got.ok) return got;
      const confirmed = z
        .record(
          z.string(),
          z.object({ thread: z.object({ id: z.string(), isResolved: z.boolean() }) }),
        )
        .safeParse(got.data);
      const t = confirmed.success ? confirmed.data[field]?.thread : undefined;

      return t?.id === thread && t.isResolved === resolved
        ? { ok: true, data: null }
        : fail('failed', 'gh review threads: thread state was not confirmed');
    },
    ready: async (repo, number) => done(await run(['pr', 'ready', String(number), '--repo', repo])),
    close: async (repo, number) => done(await run(['pr', 'close', String(number), '--repo', repo])),
    say: async (repo, number, body) =>
      done(await run(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], body)),
    defaultBranch: async (repo) => {
      const r = await run([
        'repo',
        'view',
        repo,
        '--json',
        'defaultBranchRef',
        '--jq',
        '.defaultBranchRef.name',
      ]);

      return r.ok ? { ok: true, data: r.data.trim() } : r;
    },
    openPrOn: async (repo, branch) => {
      const r = await json(
        z.array(z.looseObject({ number: z.number().int(), url: z.string().min(1) })),
        [
          'pr',
          'list',
          '--repo',
          repo,
          '--head',
          branch,
          '--state',
          'open',
          '--limit',
          '1',
          '--json',
          'number,url',
        ],
        'gh pr list',
      );

      if (!r.ok) return r;
      const first = r.data[0];

      return {
        ok: true,
        data: first === undefined ? null : { number: first.number, url: first.url },
      };
    },
    createDraft: async ({ repo, branch, base, title, body }) => {
      const r = await run([
        'pr',
        'create',
        '--repo',
        repo,
        '--head',
        branch,
        '--base',
        base,
        '--title',
        title,
        '--body',
        body,
        '--draft',
      ]);

      if (!r.ok) return r;
      const url = r.data.trim().split('\n').at(-1) ?? '';
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);

      return Number.isInteger(number) && number > 0
        ? { ok: true, data: { number, url } }
        : fail('failed', 'the pull request answered no number');
    },
    people: async (repo) => {
      const [owner = repo, name = ''] = repo.split('/');
      const r = await json(
        z.array(Person),
        [
          'api',
          'graphql',
          '-F',
          `owner=${owner}`,
          '-F',
          `name=${name}`,
          '-f',
          'query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { assignableUsers(first: 100) { nodes { login name } } } }',
          '--jq',
          '.data.repository.assignableUsers.nodes',
        ],
        'gh api graphql',
      );

      return r.ok
        ? { ok: true, data: r.data.map((p) => ({ login: p.login, name: p.name ?? '' })) }
        : r;
    },
    requestReviewers: async (repo, number, logins) =>
      logins.length === 0
        ? { ok: true, data: null }
        : done(
            await send('POST', `repos/${repo}/pulls/${number}/requested_reviewers`, {
              reviewers: logins,
            }),
          ),
  };
};

/** Original coordinates still match after later commits make a posted comment outdated. */
const sameComment = (posted: RestComment, wanted: Record<string, unknown>): boolean => {
  const line = posted.original_line ?? posted.line ?? null;
  const start = posted.original_start_line ?? posted.start_line ?? null;

  return (
    posted.path === wanted.path &&
    posted.body === wanted.body &&
    posted.side === wanted.side &&
    line === wanted.line &&
    start === (wanted.start_line ?? null) &&
    (start === null || posted.start_side === wanted.start_side)
  );
};
