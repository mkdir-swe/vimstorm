/**
 * A fake `gh` on disk, built on `fakeTool`. It answers by the first pattern its arguments contain,
 * else with GitHub's 404. The shapes below are GitHub's own REST shapes and `gh pr view --json`'s
 * GraphQL names, cut to the fields Abe reads.
 */
import { type FakeTool, fakeTool, type ToolAnswer } from './tool';

export type GhAnswer = ToolAnswer;
export type FakeGh = FakeTool;

export const NOT_FOUND: GhAnswer = {
  stdout: '{"message":"Not Found","status":"404"}',
  stderr: 'gh: Not Found (HTTP 404)',
  exit: 1,
};

/**
 * A pull request's head with no checks. GitHub answers no workflow runs and no commit statuses for
 * a commit nothing ran on. The fake gh gives these after a test's own answers.
 */
export const GH_NO_CHECKS: readonly (readonly [string, GhAnswer])[] = [
  ['actions/runs?head_sha=', { json: { total_count: 0, workflow_runs: [] } }],
  ['/status?per_page=', { json: { state: 'pending', total_count: 0, statuses: [] } }],
];

export const fakeGh = (answers: readonly (readonly [string, GhAnswer])[] = []): FakeGh => {
  const tool = fakeTool('gh', NOT_FOUND, [...answers, ...GH_NO_CHECKS]);

  return {
    ...tool,
    answer: (list) => {
      tool.answer([...list, ...GH_NO_CHECKS]);
    },
  };
};

/** A workflow run as `GET /repos/{o}/{r}/actions/runs?head_sha=` lists it, in REST's lower case. */
export const ghWorkflowRun = (
  name: string,
  status: string,
  conclusion: string | null,
  o: {
    id?: number;
    workflowId?: number;
    createdAt?: string;
    updatedAt?: string;
    branch?: string;
  } = {},
) => ({
  id: o.id ?? 1000 + name.length,
  name,
  workflow_id: o.workflowId ?? name.length,
  status,
  conclusion,
  head_sha: GH_PR_HEAD,
  head_branch: o.branch ?? 't1-change',
  event: 'pull_request',
  html_url: `https://github.com/o/r/actions/runs/${o.id ?? 1000 + name.length}`,
  created_at: o.createdAt ?? '2026-10-23T00:37:58Z',
  updated_at: o.updatedAt ?? o.createdAt ?? '2026-10-23T00:37:58Z',
});

/**
 * A review as `GET /repos/{o}/{r}/pulls/{n}/reviews` lists it. `PENDING` means not submitted yet.
 */
export const ghReview = (id: number, login: string, state: string) => ({
  id,
  node_id: `PRR_${id}`,
  user: { login, id: 100 + id },
  body: '',
  state,
  html_url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
  submitted_at: state === 'PENDING' ? null : '2026-10-23T09:00:00Z',
});

/** A commit status as `GET /repos/{o}/{r}/commits/{sha}/status` lists it. */
export const ghCommitStatus = (context: string, state: string) => ({
  context,
  state,
  target_url: `https://ci.example.test/${context}`,
  created_at: '2026-10-23T00:37:58Z',
});

/** The checks on a pull request's head: its workflow runs and its commit statuses. */
export const ghChecks = (
  sha: string,
  runs: readonly unknown[],
  statuses: readonly unknown[] = [],
): [string, GhAnswer][] => [
  [`head_sha=${sha}`, { json: { total_count: runs.length, workflow_runs: runs } }],
  [
    `${sha}/status?per_page=`,
    { json: { state: 'pending', total_count: statuses.length, statuses } },
  ],
];

/** `GET /user`, cut to what Abe reads. */
export const ghUser = (login: string) => ({ login, id: 1, type: 'User', name: null });

const API = 'https://api.github.com/repos';

/** An issue as `GET /repos/{owner}/{repo}/issues/{n}` answers it. */
export const ghIssue = (
  repo: string,
  number: number,
  o: {
    title?: string;
    body?: string | null;
    state?: 'open' | 'closed';
    labels?: string[];
    /** Why it was closed (`completed`, `not_planned`); null while open. */
    stateReason?: string | null;
    assignees?: string[];
    updatedAt?: string;
    closedAt?: string | null;
    /** It is a pull request's number (the issues endpoints list those too). */
    pull?: boolean;
  } = {},
) => ({
  id: 9_000_000 + number,
  node_id: `I_kw${number}`,
  number,
  title: o.title ?? `Issue ${number}`,
  body: o.body === undefined ? `Body of ${number}.` : o.body,
  state: o.state ?? 'open',
  state_reason: o.stateReason ?? null,
  html_url: `https://github.com/${repo}/issues/${number}`,
  url: `${API}/${repo}/issues/${number}`,
  repository_url: `${API}/${repo}`,
  labels: (o.labels ?? []).map((name, i) => ({ id: i + 1, name, color: '0E8A16', default: false })),
  assignees: (o.assignees ?? []).map((login, i) => ({ login, id: 100 + i })),
  user: { login: 'octocat', id: 1 },
  sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
  created_at: '2026-10-23T09:00:00Z',
  updated_at: o.updatedAt ?? '2026-10-23T09:00:00Z',
  closed_at: o.closedAt ?? null,
  ...(o.pull === true ? { pull_request: { url: `${API}/${repo}/pulls/${number}` } } : {}),
});

/** A fake pull request's head commit unless a test names one. */
export const GH_PR_HEAD = '6378c0009ba02dd15f0af334b9902a58b260913f';

/** A pull request as `gh pr view --json number,title,body,url,state,isDraft,…` prints it. */
export const ghPrView = (
  repo: string,
  number: number,
  o: {
    state?: 'OPEN' | 'CLOSED' | 'MERGED';
    mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    isDraft?: boolean;
    head?: string;
    /** The head commit. Defaults to a fixed one. */
    sha?: string;
    mergeCommit?: string;
    /** Users asked to review, by login. */
    requested?: readonly string[];
    /** Each reviewer's latest review: login and GitHub's state (`APPROVED`, `CHANGES_REQUESTED`). */
    reviews?: readonly (readonly [string, string])[];
  } = {},
) => ({
  number,
  title: `Pull ${number}`,
  body: `Body of pull ${number}.`,
  url: `https://github.com/${repo}/pull/${number}`,
  state: o.state ?? 'OPEN',
  isDraft: o.isDraft ?? false,
  headRefName: o.head ?? `t${number}-change`,
  headRefOid: o.sha ?? GH_PR_HEAD,
  baseRefName: 'main',
  mergeable: o.mergeable ?? 'MERGEABLE',
  mergeCommit: o.mergeCommit === undefined ? null : { oid: o.mergeCommit },
  reviewRequests: (o.requested ?? []).map((login) => ({ __typename: 'User', login })),
  latestReviews: (o.reviews ?? []).map(([login, state], i) => ({
    id: `PRR_${i + 1}`,
    author: { login },
    state,
    submittedAt: '2026-10-23T09:00:00Z',
  })),
});

/** A comment as `POST /repos/{owner}/{repo}/issues/{n}/comments` answers it. */
export const ghIssueComment = (repo: string, number: number, id: number, body: string) => ({
  id,
  node_id: `IC_${id}`,
  body,
  html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${id}`,
  issue_url: `${API}/${repo}/issues/${number}`,
  user: { login: 'octocat', id: 1 },
  created_at: '2026-10-23T09:00:00Z',
  updated_at: '2026-10-23T09:00:00Z',
});

/** A pull request as the REST `pulls` endpoints answer it. */
export const ghPull = (repo: string, number: number) => ({
  id: 7_000_000 + number,
  number,
  state: 'open',
  html_url: `https://github.com/${repo}/pull/${number}`,
  url: `${API}/${repo}/pulls/${number}`,
});

/** A pull request as `GET /repos/{o}/{r}/pulls?state=all&sort=updated` lists it. */
export const ghListedPull = (
  repo: string,
  number: number,
  o: {
    title?: string;
    state?: 'open' | 'closed';
    mergedAt?: string;
    branch?: string;
    updatedAt: string;
  },
) => ({
  ...ghPull(repo, number),
  title: o.title ?? `Change ${number}`,
  state: o.state ?? 'open',
  merged_at: o.mergedAt ?? null,
  head: { ref: o.branch ?? `card/${number}`, sha: GH_PR_HEAD },
  base: { ref: 'main' },
  updated_at: o.updatedAt,
});

export const ghDeployment = (
  repo: string,
  id: number,
  sha: string,
  environment: string,
  createdAt: string,
) => ({
  id,
  node_id: `DE_${id}`,
  sha,
  ref: 'main',
  task: 'deploy',
  environment,
  description: null,
  creator: { login: 'github-actions[bot]', id: 41898282 },
  created_at: createdAt,
  updated_at: createdAt,
  url: `${API}/${repo}/deployments/${id}`,
  statuses_url: `${API}/${repo}/deployments/${id}/statuses`,
  transient_environment: false,
  production_environment: false,
});

export const ghDeploymentStatus = (id: number, state: string, createdAt: string) => ({
  id,
  node_id: `DES_${id}`,
  state,
  description: state === 'success' ? 'Deployment finished successfully.' : '',
  environment: 'test',
  target_url: `https://github.com/o/r/actions/runs/${id}`,
  log_url: `https://github.com/o/r/actions/runs/${id}`,
  environment_url: '',
  created_at: createdAt,
  updated_at: createdAt,
  creator: { login: 'github-actions[bot]', id: 41898282 },
});
