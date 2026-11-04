/**
 * `abe review …`'s answers: the shapes VimStorm's PR review (the Git Log's `PR: #n` filter, its
 * files pane, the diff's `,i` keys) reads over the bridge. `review show` is the whole read; the
 * writes answer the doc they wrote and what the status line says.
 */
import { z } from 'zod';
import { Drafts, SideSchema } from './drafts';
import { Marks } from './marks';

const FileStatusSchema = z.enum(['A', 'M', 'D', 'R']);
const MechanicalSchema = z.enum([
  'imports',
  'rename',
  'format',
  'lockfile',
  'generated',
  'snapshot',
  'build',
]);

/** A file of the PR's diff as the review lists it. */
export const ReadFile = z.object({
  path: z.string(),
  previous: z.string().optional(),
  status: FileStatusSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  /** Its change's hash: a mark of the same hash is a file reviewed as it is now. */
  hash: z.string(),
  /** Each hunk's head line (where ⏎ lands), in order. */
  heads: z.array(z.number().int()),
});
export type ReadFile = z.infer<typeof ReadFile>;

/** A file one commit changed, with its path in the PR's diff; null when the diff lacks it. */
export const ReadCommitFile = z.object({
  path: z.string(),
  previous: z.string().optional(),
  finalPath: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  heads: z.array(z.number().int()),
});
export type ReadCommitFile = z.infer<typeof ReadCommitFile>;

/** One of the PR's commits with the files it changed. */
export const ReadCommit = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  files: z.array(ReadCommitFile),
});
export type ReadCommit = z.infer<typeof ReadCommit>;

export const ReviewRead = z.object({
  /** The commit read: the checkout's HEAD (GitHub's head when not checked out). */
  head: z.string(),
  /** The merge base; null when not checked out. */
  base: z.string().nullable(),
  /** The checkout the files were read in; null when not checked out. */
  worktree: z.string().nullable(),
  files: z.array(ReadFile),
  /** Oldest first. */
  commits: z.array(ReadCommit),
  /** The commits since your review, by sha. */
  fresh: z.array(z.string()),
  mechanical: z.record(z.string(), MechanicalSchema),
  /** A copy's path → the file it repeats. */
  copies: z.record(z.string(), z.string()),
  /** Each file's area: its package's folder, '' at the repository's root. */
  areas: z.record(z.string(), z.string()),
  since: z.object({ from: z.string(), paths: z.array(z.string()) }).nullable(),
});
export type ReviewRead = z.infer<typeof ReviewRead>;

/** A comment of a posted discussion. */
export const ThreadComment = z.object({
  id: z.number().int(),
  author: z.string(),
  body: z.string(),
  url: z.string(),
});

/** A posted discussion on the PR's diff: its anchor and what GitHub lets you do with it. */
export const Thread = z.object({
  id: z.string(),
  path: z.string(),
  side: SideSchema,
  line: z.number().int().nullable(),
  start: z.number().int().nullable(),
  head: z.string(),
  outdated: z.boolean(),
  resolved: z.boolean(),
  canReply: z.boolean(),
  canResolve: z.boolean(),
  comments: z.array(ThreadComment),
});
export type Thread = z.infer<typeof Thread>;

/**
 * The PR's conversation as GitHub shows it, oldest first: its comments and the reviews submitted
 * with a verdict or a summary (a review that only wraps line comments is left out).
 */
export const ConversationItem = z.object({
  kind: z.enum(['comment', 'approved', 'changes', 'commented', 'dismissed']),
  author: z.string(),
  body: z.string(),
  /** RFC 3339. */
  at: z.string(),
});
export type ConversationItem = z.infer<typeof ConversationItem>;

/** The PR as the review reads it: the strip's facts and what its lifecycle rows weigh. */
export const ReviewPr = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  /** The head branch and the base branch. */
  branch: z.string(),
  base: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  /** The head's commit on GitHub now. */
  head: z.string(),
  /** GitHub's review decision; null when the repository asks for none. */
  decision: z.enum(['approved', 'changes', 'required']).nullable(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  /** GitHub's mergeStateStatus, lower case (`clean`, `behind`, `blocked`, `dirty` …). */
  mergeState: z.string(),
  checks: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    /** The failing ones' names. */
    failing: z.array(z.string()),
    running: z.boolean(),
  }),
  /** When GitHub last saw the PR change (a push, a comment, a review); absent when not read. */
  updatedAt: z.string().optional(),
  /** The head branch's repository when it is a fork (`owner/name`); absent: the PR's own. */
  fork: z.string().optional(),
  /** Its conversation; absent when not read. */
  conversation: z.array(ConversationItem).optional(),
});
export type ReviewPr = z.infer<typeof ReviewPr>;

/** `abe review pr`: the PR alone, one GitHub read (the review's poll for what moved). */
export const ReviewPrData = z.object({ pr: ReviewPr });
export type ReviewPrData = z.infer<typeof ReviewPrData>;

export const reviewPrText = (d: ReviewPrData): string =>
  `PR #${d.pr.number} · ${d.pr.title} · ${d.pr.head.slice(0, 8)}${d.pr.updatedAt === undefined ? '' : ` · ${d.pr.updatedAt}`}`;

/** `abe review show`: the PR, who you are, its changes read, the marks, drafts and discussions. */
export const ReviewShowData = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  /** The checkout the PR is reviewed in, and its main checkout (the docs live there). */
  path: z.string(),
  main: z.string(),
  pr: ReviewPr,
  /** gh's login; null when it could not say. */
  me: z.string().nullable(),
  /** Why the PR is not checked out here: its files come from GitHub, ⏎ cannot open them. */
  unchecked: z.string().nullable(),
  read: ReviewRead,
  marks: Marks.nullable(),
  drafts: Drafts,
  /** The discussions; null with why when GitHub did not give them. */
  threads: z.array(Thread).nullable(),
  threadsError: z.string().nullable(),
});
export type ReviewShowData = z.infer<typeof ReviewShowData>;

export const reviewShowText = (d: ReviewShowData): string =>
  [
    `PR #${d.number} · ${d.pr.title}`,
    `${d.read.files.length} file${d.read.files.length === 1 ? '' : 's'} · ${d.path}`,
    ...d.read.files.map((f) => `  ${f.status} ${f.path} +${f.additions} −${f.deletions}`),
  ].join('\n');

/** `abe review mark`: the marks as written. */
export const ReviewMarksData = z.object({ marks: Marks });
export type ReviewMarksData = z.infer<typeof ReviewMarksData>;

export const reviewMarksText = (d: ReviewMarksData): string =>
  `${Object.keys(d.marks.marks).length} of ${d.marks.paths.length} files reviewed`;

/** A drafts write: the doc as written and what the status line says. */
export const ReviewDraftsData = z.object({ drafts: Drafts, said: z.string() });
export type ReviewDraftsData = z.infer<typeof ReviewDraftsData>;

/** `abe review resolve`: what the status line says. */
export const ReviewSaidData = z.object({ said: z.string() });
export type ReviewSaidData = z.infer<typeof ReviewSaidData>;

/** An open PR as the Log's `PR ⌄` pick lists it. */
export const OpenPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  branch: z.string(),
  draft: z.boolean(),
  /** Who is asked to review it, by login. */
  requested: z.array(z.string()),
});
export type OpenPr = z.infer<typeof OpenPr>;

/** `abe review prs`: the checkout's GitHub repo, who you are and its open PRs. */
export const ReviewPrsData = z.object({
  repo: z.string(),
  me: z.string().nullable(),
  prs: z.array(OpenPr),
});
export type ReviewPrsData = z.infer<typeof ReviewPrsData>;

export const reviewPrsText = (d: ReviewPrsData): string =>
  d.prs.length === 0
    ? `No open pull requests · ${d.repo}`
    : d.prs.map((p) => `#${p.number} ${p.title}   ${p.branch}`).join('\n');

/** `abe review open`: where the PR is checked out to be reviewed (the main checkout on a failure). */
export const ReviewOpenData = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  path: z.string(),
  /** Why it could not be checked out; null when it was. */
  unchecked: z.string().nullable(),
});
export type ReviewOpenData = z.infer<typeof ReviewOpenData>;

export const reviewOpenText = (d: ReviewOpenData): string =>
  d.unchecked === null
    ? `PR #${d.number} · VimStorm ← ${d.path}`
    : `✗ PR #${d.number} not checked out: ${d.unchecked} · files from GitHub`;

/** The codes a review write refuses with: `review-refused` a warning, `review-failed` an error. */
export const REVIEW_REFUSED = 'review-refused';
export const REVIEW_FAILED = 'review-failed';

/** `abe pr draft-plan`: what Create Draft PR starts from, read without writing anything. */
export const DraftPrPlanData = z.object({
  root: z.string(),
  repo: z.string(),
  branch: z.string(),
  head: z.string(),
  base: z.string(),
  origin: z.string(),
  title: z.string(),
  body: z.string(),
  commits: z.number().int(),
  files: z.number().int(),
  uncommitted: z.array(z.string()),
  published: z.boolean(),
  existing: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  branches: z.array(z.string()),
  reviewers: z.array(z.object({ login: z.string(), name: z.string() })),
});

export const draftPrPlanText = (d: z.infer<typeof DraftPrPlanData>): string =>
  [
    `${d.repo}: ${d.base} ← ${d.branch} · ${d.commits} commit${d.commits === 1 ? '' : 's'}, ${d.files} file${d.files === 1 ? '' : 's'}`,
    d.existing === null
      ? `title: ${d.title}`
      : `PR #${d.existing.number} is open: ${d.existing.url}`,
  ].join('\n');

/** `abe pr draft-create`: the draft PR (or the one open on the branch), and reviewers not asked. */
export const DraftPrMadeData = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  /** Why the reviewers were not asked; null when they were (or none was named). */
  asked: z.string().nullable(),
});
export type DraftPrMadeData = z.infer<typeof DraftPrMadeData>;

export const draftPrMadeText = (d: DraftPrMadeData): string =>
  d.asked === null
    ? `PR #${d.number} · ${d.url}`
    : `PR #${d.number} · ${d.url}\nreviewers not asked: ${d.asked}`;
