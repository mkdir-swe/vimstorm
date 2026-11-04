/**
 * Tracking on GitHub through `gh`: REST through `gh api` (issues, sub-issues, writes,
 * deployments, a pull request's checks) and `gh pr view` for a pull request. A pull request's
 * checks are its head's Actions workflow runs (the newest per workflow) and commit statuses, never
 * check runs: a fine-grained token, a box's login, cannot read those (GitHub offers it no Checks
 * permission, #67). GitHub's answers are read with zod here; what they mean is core's
 * (`checkRunState`, `deployState` …).
 */
import {
  type Check,
  checkRunState,
  checksState,
  deployState,
  FRESH_PAGE,
  type IssueData,
  type LinkedIssue,
  newest,
  type PrData,
  prReviewersOf,
  type Ref,
  statusContextState,
  type Tracked,
  showRef,
  type Tracking,
} from '@abe/core';
import { z } from 'zod';
import { type Gh, ghRunner, readGh as read } from './gh';
import { type Env } from '../mac/locations';

const RestIssue = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  html_url: z.string(),
  repository_url: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  /** Set when the number is a pull request's: the issues endpoints answer for those too. */
  pull_request: z.unknown().optional(),
});
type RestIssue = z.infer<typeof RestIssue>;

const WorkflowRuns = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string().nullable(),
      workflow_id: z.number(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
      created_at: z.string(),
    }),
  ),
});
type WorkflowRun = z.infer<typeof WorkflowRuns>['workflow_runs'][number];
/** A pull request as `GET /repos/{o}/{r}/pulls` lists it, cut to what a fresh look reads. */
const ListedPull = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string() }),
  updated_at: z.string(),
});

const RestReview = z.object({
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
});
const CombinedStatus = z.object({
  statuses: z.array(
    z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable() }),
  ),
});

/** Each workflow's newest run (a re-run or a later event on the same head replaces it). */
const newestPerWorkflow = (runs: readonly WorkflowRun[]): WorkflowRun[] => {
  const kept = new Map<number, WorkflowRun>();

  for (const r of runs) {
    const had = kept.get(r.workflow_id);

    if (had === undefined || r.created_at > had.created_at) kept.set(r.workflow_id, r);
  }

  return [...kept.values()];
};

const PR_FIELDS = [
  'number',
  'title',
  'body',
  'url',
  'state',
  'isDraft',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'mergeable',
  'mergeCommit',
  'reviewRequests',
  'latestReviews',
];

const PrView = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
  /** A user by its login, a team by its slug. */
  reviewRequests: z
    .array(z.object({ login: z.string().optional(), slug: z.string().optional() }))
    .default([]),
  latestReviews: z
    .array(z.object({ author: z.object({ login: z.string() }).nullable(), state: z.string() }))
    .default([]),
});

const STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const;
const MERGEABLE = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
} as const;

const RestPull = z.object({ number: z.number() });
const RestComment = z.object({ id: z.number(), html_url: z.string() });
const Merged = z.object({ sha: z.string(), merged: z.boolean() });
const created = <T extends { created_at: string }>({ created_at, ...rest }: T) => ({
  ...rest,
  createdAt: created_at,
});
const Deployment = z.object({ id: z.number(), created_at: z.string() }).transform(created);
const DeploymentStatus = z
  .object({
    id: z.number(),
    state: z.string(),
    created_at: z.string(),
    description: z.string().nullable(),
    log_url: z.string().nullish(),
    target_url: z.string().nullish(),
  })
  .transform(created);

/** `https://api.github.com/repos/o/r` → `o/r`. */
const repoOf = (url: string) => url.split('/').slice(-2).join('/');

const linked = (i: RestIssue): LinkedIssue => ({
  repo: repoOf(i.repository_url),
  number: i.number,
  title: i.title,
  state: i.state,
});

const filled = (text: string | null | undefined) =>
  text === undefined || text === null || text === '' ? null : text;

const isPull = (ref: Ref): Tracked<never> => ({
  ok: false,
  error: { code: 'not-found', message: `${showRef(ref)} is a pull request, not an issue` },
});

export const ghTracking = (gh: Gh): Tracking => {
  const call = async <T extends z.ZodType>(
    schema: T,
    args: readonly string[],
    input?: unknown,
  ): Promise<Tracked<z.output<T>>> => {
    const out = await gh(args, input === undefined ? undefined : JSON.stringify(input));

    return out.ok ? read(schema, out.stdout) : out;
  };
  const api = <T extends z.ZodType>(schema: T, path: string) => call(schema, ['api', path]);
  const send = <T extends z.ZodType>(schema: T, method: string, path: string, input: unknown) =>
    call(schema, ['api', '-X', method, path, '--input', '-'], input);

  const issueShow = async (ref: Ref): Promise<Tracked<IssueData>> => {
    const at = `repos/${ref.repo}/issues/${ref.number}`;
    const issue = await api(RestIssue, at);

    if (!issue.ok) return issue;
    if (issue.data.pull_request !== undefined) return isPull(ref);
    const [subs, parent] = await Promise.all([
      api(z.array(RestIssue), `${at}/sub_issues?per_page=100`),
      api(RestIssue, `${at}/parent`),
    ]);

    if (!subs.ok) return subs;
    // GitHub answers 404 for an issue with no parent.
    if (!parent.ok && parent.error.code !== 'not-found') return parent;
    const i = issue.data;

    return {
      ok: true,
      data: {
        repo: ref.repo,
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        state: i.state,
        url: i.html_url,
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        parent: parent.ok ? linked(parent.data) : null,
        subIssues: subs.data.map(linked),
      },
    };
  };

  const prShow = async (ref: Ref): Promise<Tracked<PrData>> => {
    const view = await call(PrView, [
      'pr',
      'view',
      String(ref.number),
      '-R',
      ref.repo,
      '--json',
      PR_FIELDS.join(','),
    ]);

    if (!view.ok) return view;
    const p = view.data;
    const sha = p.headRefOid;
    const [workflows, statuses] = await Promise.all([
      api(WorkflowRuns, `repos/${ref.repo}/actions/runs?head_sha=${sha}&per_page=100`),
      api(CombinedStatus, `repos/${ref.repo}/commits/${sha}/status?per_page=100`),
    ]);

    if (!workflows.ok) return workflows;
    if (!statuses.ok) return statuses;
    // REST names them in lower case; core reads GitHub's GraphQL (upper case) names.
    const runs: Check[] = [
      ...newestPerWorkflow(workflows.data.workflow_runs).map((r): Check => ({
        name: r.name ?? `workflow ${r.workflow_id}`,
        state: checkRunState(
          (r.status ?? '').toUpperCase(),
          r.conclusion === null ? null : r.conclusion.toUpperCase(),
        ),
        url: filled(r.html_url),
      })),
      ...statuses.data.statuses.map((s): Check => ({
        name: s.context,
        state: statusContextState(s.state.toUpperCase()),
        url: filled(s.target_url),
      })),
    ];

    return {
      ok: true,
      data: {
        repo: ref.repo,
        number: p.number,
        title: p.title,
        body: p.body,
        url: p.url,
        state: STATES[p.state],
        draft: p.isDraft,
        head: { ref: p.headRefName, sha: p.headRefOid },
        base: { ref: p.baseRefName },
        mergeable: MERGEABLE[p.mergeable],
        checks: { state: checksState(runs), runs },
        mergeCommit: p.mergeCommit?.oid ?? null,
        reviewers: prReviewersOf(
          p.reviewRequests.map((r) => r.login ?? r.slug ?? ''),
          p.latestReviews.map((r) => ({ login: r.author?.login ?? '', state: r.state })),
        ),
      },
    };
  };

  return {
    issueShow,
    issueCreate: async (input) => {
      if (input.parent !== undefined) {
        // Checked first, so a parent that is not there leaves no issue behind.
        const parentRef = { repo: input.repo, number: input.parent };
        const parent = await api(RestIssue, `repos/${input.repo}/issues/${input.parent}`);

        if (!parent.ok) return parent;
        if (parent.data.pull_request !== undefined) return isPull(parentRef);
      }
      const created = await send(RestIssue, 'POST', `repos/${input.repo}/issues`, {
        title: input.title,
        body: input.body,
        labels: input.labels,
      });

      if (!created.ok) return created;
      const ref = { repo: input.repo, number: created.data.number };

      if (input.parent !== undefined) {
        const parent = { repo: input.repo, number: input.parent };
        const link = await send(
          z.unknown(),
          'POST',
          `repos/${input.repo}/issues/${input.parent}/sub_issues`,
          {
            sub_issue_id: created.data.id,
          },
        );

        if (!link.ok) {
          const why = `opened ${created.data.html_url} but could not make it a sub-issue of #${parent.number}`;

          return {
            ok: false,
            error: { code: link.error.code, message: `${why}: ${link.error.message}` },
          };
        }
      }

      return issueShow(ref);
    },
    issueComment: async (ref, body) => {
      const made = await send(
        RestComment,
        'POST',
        `repos/${ref.repo}/issues/${ref.number}/comments`,
        { body },
      );

      return made.ok
        ? { ok: true, data: { ...ref, id: made.data.id, url: made.data.html_url } }
        : made;
    },
    prShow,
    prFind: async ({ repo, head }) => {
      const [owner] = repo.split('/');
      const open = await call(z.array(RestPull), [
        'api',
        '-X',
        'GET',
        `repos/${repo}/pulls`,
        '-f',
        `head=${owner ?? ''}:${head}`,
        '-f',
        'state=open',
        '-f',
        'per_page=1',
      ]);

      if (!open.ok) return open;
      const [first] = open.data;

      return first === undefined
        ? { ok: true, data: null }
        : prShow({ repo, number: first.number });
    },
    prCreate: async (input) => {
      const created = await send(RestPull, 'POST', `repos/${input.repo}/pulls`, {
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        draft: input.draft,
      });

      return created.ok ? prShow({ repo: input.repo, number: created.data.number }) : created;
    },
    prUpdate: async (ref, change) => {
      const updated = await send(
        RestPull,
        'PATCH',
        `repos/${ref.repo}/pulls/${ref.number}`,
        change,
      );

      return updated.ok ? prShow(ref) : updated;
    },
    prMerge: async (ref, how) => {
      const merged = await send(Merged, 'PUT', `repos/${ref.repo}/pulls/${ref.number}/merge`, {
        merge_method: how.method,
        ...(how.sha === undefined ? {} : { sha: how.sha }),
      });

      if (!merged.ok) return merged;
      const branch = how.deleteBranch;

      if (branch === undefined || !merged.data.merged)
        return { ok: true, data: { ...ref, ...merged.data } };
      const path = `repos/${ref.repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      const deleted = await gh(['api', '-X', 'DELETE', path]);
      // 422 "Reference does not exist": GitHub deleted it itself (the repo's own setting).
      const gone = !deleted.ok && /Reference does not exist/i.test(deleted.error.message);

      return {
        ok: true,
        data: {
          ...ref,
          ...merged.data,
          branch: {
            name: branch,
            deleted: deleted.ok || gone,
            error: deleted.ok || gone ? null : deleted.error.message,
          },
        },
      };
    },
    issueList: async (repo) => {
      const issues = await api(
        z.array(RestIssue),
        `repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`,
      );

      if (!issues.ok) return issues;

      return {
        ok: true,
        data: issues.data
          // The issues endpoint lists pull requests too.
          .filter((i) => i.pull_request === undefined)
          .map((i) => ({
            repo,
            number: i.number,
            title: i.title,
            body: i.body ?? '',
            url: i.html_url,
            labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
          })),
      };
    },
    prReviews: async (ref) => {
      const reviews = await api(
        z.array(RestReview),
        `repos/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`,
      );

      return reviews.ok
        ? {
            ok: true,
            data: reviews.data
              .filter((r) => r.state !== 'PENDING')
              .map((r) => ({ by: r.user?.login ?? 'ghost', state: r.state })),
          }
        : reviews;
    },
    recentPrs: async (repo) => {
      const pulls = await api(
        z.array(ListedPull),
        `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${FRESH_PAGE}`,
      );

      return pulls.ok
        ? {
            ok: true,
            data: pulls.data.map((p) => ({
              number: p.number,
              title: p.title,
              state: p.merged_at === null ? p.state : 'merged',
              branch: p.head.ref,
              updatedAt: p.updated_at,
            })),
          }
        : pulls;
    },
    me: async () => {
      const user = await api(z.object({ login: z.string().min(1) }), 'user');

      return user.ok ? { ok: true, data: { login: user.data.login } } : user;
    },
    deployStatus: async ({ repo, sha, environment }) => {
      const deployments = await call(z.array(Deployment), [
        'api',
        '-X',
        'GET',
        `repos/${repo}/deployments`,
        '-f',
        `sha=${sha}`,
        '-f',
        `environment=${environment}`,
        '-f',
        'per_page=100',
      ]);

      if (!deployments.ok) return deployments;
      const deployment = newest(deployments.data);

      if (deployment === undefined)
        return { ok: true, data: { repo, sha, environment, state: 'none', deployment: null } };
      const statuses = await api(
        z.array(DeploymentStatus),
        `repos/${repo}/deployments/${deployment.id}/statuses?per_page=100`,
      );

      if (!statuses.ok) return statuses;
      const latest = newest(statuses.data);

      return {
        ok: true,
        data: {
          repo,
          sha,
          environment,
          state: deployState(statuses.data),
          deployment: {
            id: deployment.id,
            createdAt: deployment.createdAt,
            status: latest?.state ?? null,
            description: filled(latest?.description),
            url: filled(latest?.log_url) ?? filled(latest?.target_url),
          },
        },
      };
    },
  };
};

/** Tracking as the person: `gh` on its keyring login, from `env` less tokens and git's variables. */
export const ghTrackingFrom = (env: Env): Tracking => ghTracking(ghRunner(env));

/**
 * On a box (`$ABE_BOX`) you are its owner: `me()` answers `$ABE_OWNER`, which the box's service
 * sets from its `abe:owner` tag (the environment roles' trust takes only that as SourceIdentity,
 * and the log store only that login's folder), never a `gh` call. The rest is `tracking`'s. Off
 * a box, `tracking` as it is.
 */
export const boxTracking = (env: Env, tracking: Tracking): Tracking => {
  if ((env.ABE_BOX ?? '') === '') return tracking;
  const owner = env.ABE_OWNER ?? '';
  const me: Tracking['me'] = () =>
    Promise.resolve(
      owner === ''
        ? {
            ok: false,
            error: {
              code: 'auth',
              message: 'this box was not told whose it is (ABE_OWNER, from its abe:owner tag)',
            },
          }
        : { ok: true, data: { login: owner } },
    );

  return { ...tracking, me };
};
