/**
 * Tracking on GitHub (ADR 0009): issues with sub-issues, pull requests and their checks, merges,
 * and a commit's deployment per environment. The results every client reads, the port's error
 * codes and the rules that turn GitHub's states into Abe's.
 */
import { z } from 'zod';

/** `<owner>/<repo>`, as GitHub allows the two names. */
const NAME = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
const REF = /^([^#]+)#([1-9][0-9]*)$/;

/** A checked `<owner>/<repo>`: only `parseRepo` / `parseRef` make one, so no path gets a stray `/`. */
export const Repo = z.string().regex(NAME).brand<'Repo'>();
export type Repo = z.infer<typeof Repo>;

/** An issue or pull request: `mkdir-swe/vimstorm#37`. */
export type Ref = { repo: Repo; number: number };

export const parseRepo = (text: string): Repo | undefined => {
  const repo = Repo.safeParse(text);

  return repo.success ? repo.data : undefined;
};

export const parseRef = (text: string): Ref | undefined => {
  const [, name, number] = REF.exec(text) ?? [];
  const repo = name === undefined ? undefined : parseRepo(name);

  return repo === undefined || number === undefined ? undefined : { repo, number: Number(number) };
};

export const showRef = (ref: { repo: string; number: number }) => `${ref.repo}#${ref.number}`;

/**
 * Why an issue could not be opened on `repo` when GitHub answered Not Found (404): it hides a
 * private repo from a login that can't read it. `login`: the gh login Abe uses there (`logins.gh`),
 * null for gh's active one.
 */
export const repoNotVisibleText = (repo: string, login: string | null): string =>
  `GitHub answered Not Found for ${repo}: the gh login Abe uses here (${login ?? "gh's active one"}) can't see it. Sign gh in as an account that can (gh auth login), and name it for this repo (abe settings set logins.gh <login> --mine); or open the issue by hand at https://github.com/${repo}/issues/new`;

/**
 * The GitHub repo a git remote URL names (`git@github.com:o/r.git`, `https://github.com/o/r`,
 * `ssh://git@github.com/o/r.git`), or `undefined` for a remote that is not GitHub's.
 */
export const githubRepoOf = (url: string): Repo | undefined => {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );

  return m?.[1] === undefined ? undefined : parseRepo(m[1]);
};

/** An open issue as a backlog lists it: never a pull request. */
export type OpenIssue = {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

/** What a failed `gh` means: the error code a client reads, with `gh`'s message. */
export const TRACKING_ERRORS = ['not-found', 'auth', 'rate-limited', 'gh-failed'] as const;
export type TrackingErrorCode = (typeof TRACKING_ERRORS)[number];
export type TrackingError = { code: TrackingErrorCode; message: string };

/** The logins gh has for github.com and its active one (`null`: none signed in). */
export type GhAccounts = { active: string | null; signedIn: string[] };

/** What a Tracking call answers: its data or why `gh` could not. */
export type Tracked<T> = { ok: true; data: T } | { ok: false; error: TrackingError };

const CODES: readonly [RegExp, TrackingErrorCode][] = [
  [/rate limit|HTTP 429/i, 'rate-limited'],
  [/HTTP 401|bad credentials|gh auth login|not logged in|authentication required/i, 'auth'],
  [/HTTP 404|could not resolve to an? /i, 'not-found'],
];

/** `gh`'s stderr → the error code; anything else is `gh-failed`. */
export const ghErrorCode = (stderr: string): TrackingErrorCode =>
  CODES.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'gh-failed';

const ref = { repo: z.string(), number: z.number().int().positive() };

/** An issue's parent or one of its sub-issues. */
export const LinkedIssue = z.object({
  ...ref,
  title: z.string(),
  state: z.enum(['open', 'closed']),
});
export type LinkedIssue = z.infer<typeof LinkedIssue>;

/** `abe issue show` / `issue create`. */
export const IssueData = z.object({
  ...ref,
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  url: z.string(),
  labels: z.array(z.string()),
  parent: LinkedIssue.nullable(),
  subIssues: z.array(LinkedIssue),
});
export type IssueData = z.infer<typeof IssueData>;

export const CheckState = z.enum(['pending', 'success', 'failure', 'skipped']);
export type CheckState = z.infer<typeof CheckState>;

/** One check run or commit status on a pull request's head. */
export const Check = z.object({ name: z.string(), state: CheckState, url: z.string().nullable() });
export type Check = z.infer<typeof Check>;

/** How many pull requests and pipeline runs a fresh look reads (#236): the last changed ones. */
export const FRESH_PAGE = 30;

/** A pull request as a fresh look sees it (#236): which one, where it stands, when it changed. */
export const PrTouch = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  /** Its head branch. */
  branch: z.string(),
  updatedAt: z.string(),
});
export type PrTouch = z.infer<typeof PrTouch>;

/** `github.changed` (#236): a repo's pull requests changed since the last look. */
export const GithubChangedEvent = z.object({
  repo: z.string(),
  prs: z.array(PrTouch),
});
export type GithubChangedEvent = z.infer<typeof GithubChangedEvent>;

export const githubChangedText = (d: GithubChangedEvent): string =>
  `${d.repo}: ${d.prs.map((p) => `#${p.number} ${p.state}`).join(', ')}`;

/** A submitted review of a pull request: its author and GitHub's state (`APPROVED` …). */
export type PrReview = { by: string; state: string };

/** Where a reviewer of a pull request stands, as GitHub last said. */
export const PR_REVIEW_STATES = [
  'requested',
  'commented',
  'approved',
  'changes-requested',
  'dismissed',
] as const;
export type PrReviewState = (typeof PR_REVIEW_STATES)[number];

/** A reviewer of the pull request: requested, or one who reviewed (their latest review). */
export const PrReviewer = z.object({ login: z.string().min(1), state: z.enum(PR_REVIEW_STATES) });
export type PrReviewer = z.infer<typeof PrReviewer>;

/** GitHub's review states (`latestReviews`) in the run's words; a pending one is none yet. */
const REVIEW_STATES: Readonly<Record<string, PrReviewState>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/**
 * A pull request's reviewers: each one requested (a team by its slug) as `requested`, else each
 * reviewer's latest submitted review; in the order GitHub lists them, each once.
 */
export const prReviewersOf = (
  requested: readonly string[],
  latest: readonly { login: string; state: string }[],
): PrReviewer[] => {
  const seen = new Set<string>();
  const out: PrReviewer[] = [];

  for (const login of requested)
    if (login !== '' && !seen.has(login)) {
      seen.add(login);
      out.push({ login, state: 'requested' });
    }
  for (const r of latest) {
    const state = REVIEW_STATES[r.state];

    if (state !== undefined && r.login !== '' && !seen.has(r.login)) {
      seen.add(r.login);
      out.push({ login: r.login, state });
    }
  }

  return out;
};

/** `abe pr show` / `pr create` / `pr update`. */
export const PrData = z.object({
  ...ref,
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  /** `unknown` while GitHub is still working it out. */
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  checks: z.object({
    state: z.enum(['none', 'pending', 'success', 'failure']),
    runs: z.array(Check),
  }),
  /** The commit its merge made on the base; null until merged. */
  mergeCommit: z.string().nullable(),
  /** Its reviewers and where each stands (`prReviewersOf`); absent: not read (a local one). */
  reviewers: z.array(PrReviewer).optional(),
});
export type PrData = z.infer<typeof PrData>;

/** A comment written on an issue or pull request. */
export const IssueCommentData = z.object({ ...ref, id: z.number().int(), url: z.string() });
export type IssueCommentData = z.infer<typeof IssueCommentData>;

export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** `abe pr merge`: the merge commit. */
export const MergeData = z.object({
  ...ref,
  merged: z.boolean(),
  sha: z.string(),
  /** With `deleteBranch`: the head branch on GitHub deleted after the merge, or why not. */
  branch: z
    .object({ name: z.string(), deleted: z.boolean(), error: z.string().nullable() })
    .optional(),
});
export type MergeData = z.infer<typeof MergeData>;

export const DeployState = z.enum(['none', 'pending', 'success', 'failure']);
export type DeployState = z.infer<typeof DeployState>;

/** `abe deploy status`: the newest deployment of a commit to an environment (what Done waits on). */
export const DeployStatusData = z.object({
  repo: z.string(),
  sha: z.string(),
  environment: z.string(),
  state: DeployState,
  deployment: z
    .object({
      id: z.number().int(),
      createdAt: z.string(),
      /**
       * GitHub's own state of the newest status (`in_progress`, `inactive` …), `null` before one.
       * `state` reads past an `inactive` (a later deployment replaced this one) to what it reached,
       * and is `pending` while there is no status yet.
       */
      status: z.string().nullable(),
      description: z.string().nullable(),
      url: z.string().nullable(),
    })
    .nullable(),
});
export type DeployStatusData = z.infer<typeof DeployStatusData>;

/** A deployment status as GitHub lists it. */
export type DeploymentStatus = { id: number; state: string; createdAt: string };

const newestFirst = <T extends { id: number; createdAt: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);

/** The newest of a list GitHub gave, by time then id. */
export const newest = <T extends { id: number; createdAt: string }>(items: readonly T[]) =>
  newestFirst(items)[0];

/**
 * A deployment's state from its statuses: none yet is pending (GitHub's own reading); `inactive`
 * means a later deployment replaced it, so it keeps the state it reached before that.
 */
export const deployState = (
  statuses: readonly DeploymentStatus[],
): Exclude<DeployState, 'none'> => {
  const status = newestFirst(statuses).find((s) => s.state !== 'inactive');

  if (status === undefined) return 'pending';
  if (status.state === 'success') return 'success';
  if (status.state === 'failure' || status.state === 'error') return 'failure';

  return 'pending';
};

const FAILED = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
]);

/** A check run's status and conclusion, as GitHub's GraphQL names them. */
export const checkRunState = (status: string, conclusion: string | null): CheckState => {
  if (status !== 'COMPLETED' || conclusion === null || conclusion === '') return 'pending';
  if (conclusion === 'SUCCESS') return 'success';
  if (FAILED.has(conclusion)) return 'failure';

  return 'skipped';
};

/** A commit status context's state (`SUCCESS`, `PENDING`, `EXPECTED`, `FAILURE`, `ERROR`). */
export const statusContextState = (state: string): CheckState => {
  if (state === 'SUCCESS') return 'success';
  if (FAILED.has(state)) return 'failure';

  return 'pending';
};

/** All checks together: any failure fails, else any pending is pending; skipped ones pass. */
export const checksState = (checks: readonly Check[]): PrData['checks']['state'] => {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';

  return 'success';
};

const linked = (i: LinkedIssue) => `${showRef(i)} (${i.state}) ${i.title}`;

export const issueText = (i: IssueData): string =>
  `${[
    `${showRef(i)} (${i.state}) ${i.title}`,
    i.url,
    ...(i.labels.length === 0 ? [] : [`labels: ${i.labels.join(', ')}`]),
    ...(i.parent === null ? [] : [`parent: ${linked(i.parent)}`]),
    ...(i.subIssues.length === 0
      ? []
      : ['sub-issues:', ...i.subIssues.map((s) => `  ${linked(s)}`)]),
  ].join('\n')}\n`;

export const prText = (p: PrData): string =>
  `${[
    `${showRef(p)} (${p.draft ? 'draft, ' : ''}${p.state}) ${p.title}`,
    p.url,
    `${p.head.ref} (${p.head.sha.slice(0, 7)}) → ${p.base.ref}, ${p.mergeable}`,
    `checks: ${p.checks.state}`,
    ...p.checks.runs.map((c) => `  ${c.state.padEnd(7)}  ${c.name}`),
  ].join('\n')}\n`;

export const mergeText = (m: MergeData): string =>
  m.merged ? `merged ${showRef(m)} as ${m.sha}\n` : `${showRef(m)} was not merged\n`;

export const deployText = (d: DeployStatusData): string =>
  d.deployment === null
    ? `no deployment of ${d.sha.slice(0, 7)} to ${d.environment}\n`
    : `${d.sha.slice(0, 7)} to ${d.environment}: ${d.state} (${d.deployment.status ?? 'no status yet'}, deployment ${d.deployment.id})\n`;
