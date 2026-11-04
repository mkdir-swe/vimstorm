/**
 * The PR review's node (the Git Log's `PR: #n` filter): the strip over the Log, the files pane
 * beside the table, and what the diff's `,i` keys show (drafts, discussions, the saved verdict).
 * One `ReviewPane` node the `review` slot's screen sends; VimStorm's Git tool window draws it
 * (`app/src/gitwin/review.rs`), its own look, never in a generic slot. Every label is said here.
 */
import { z } from 'zod';

const Tone = z.enum(['info', 'ok', 'warn', 'error']);
const Side = z.enum(['LEFT', 'RIGHT']);
const Status = z.enum(['A', 'M', 'D', 'R']);

const NodeLineSchema = z.strictObject({
  kind: z.literal('node'),
  key: z.string(),
  node: z.enum(['dir', 'area', 'group']),
  label: z.string(),
  depth: z.number().int(),
  open: z.boolean(),
  /** Its files, and `· not ranked` after a group's count. */
  count: z.string(),
  /** Every PR file under it is reviewed. */
  reviewed: z.boolean(),
});

const FileLineSchema = z.strictObject({
  kind: z.literal('file'),
  path: z.string(),
  label: z.string(),
  depth: z.number().int(),
  status: Status,
  /** The heat shown (`·` none). */
  heat: z.string(),
  /** By heat: every file by its full path, its heat in front, its folder dim after. */
  flat: z.boolean(),
  reviewed: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Its changes in scope, and the one in focus (the cursor's file, once stepped into). */
  changes: z.number().int(),
  hunk: z.number().int().nullable(),
  /** Posted discussions on the file, drafts waiting on it, one of them outdated. */
  threads: z.number().int(),
  drafts: z.number().int(),
  outdated: z.boolean(),
});

export const PaneLineSchema = z.discriminatedUnion('kind', [
  NodeLineSchema,
  FileLineSchema,
  z.strictObject({ kind: z.literal('band') }),
  z.strictObject({ kind: z.literal('gap') }),
]);
export type PaneLine = z.infer<typeof PaneLineSchema>;

const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('commit'), place: z.number().int(), sha: z.string() }),
  z.strictObject({
    kind: z.literal('range'),
    from: z.number().int(),
    to: z.number().int(),
    fromSha: z.string(),
    toSha: z.string(),
  }),
]);
export type PaneScope = z.infer<typeof ScopeSchema>;

const StripCommitSchema = z.strictObject({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  /** The files it changed (their paths at the PR's head) with their counts. */
  files: z.array(
    z.strictObject({ path: z.string(), additions: z.number().int(), deletions: z.number().int() }),
  ),
});

/** The PR strip over the Log and the files pane's count. */
export const StripSchema = z.strictObject({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  branch: z.string(),
  base: z.string(),
  body: z.string(),
  badge: z.enum(['open', 'draft', 'merged', 'closed']),
  /** `✓ 4 checks`, `● 3/4 checks`, `✗ 1 failed`; none without checks. */
  checks: z.strictObject({ label: z.string(), hue: z.enum(['good', 'warn', 'bad']) }).nullable(),
  /** `2 threads · 1 open`, warn while one is open; none without threads. */
  threads: z.strictObject({ label: z.string(), open: z.boolean() }).nullable(),
  /** Drafts written on a head the read moved past: Submit review waits for them. */
  outdated: z.number().int(),
  /** Your own PR: GitHub takes a Comment only. */
  own: z.boolean(),
  /** Drafts waiting to go with Submit review. */
  drafts: z.number().int(),
  scope: ScopeSchema,
  /** The strip's scope, its sub after `·`, and the diff's switch's (`Commit 3/5 · a1b2c3d4`). */
  scopeLabel: z.string(),
  scopeSub: z.string(),
  switchLabel: z.string(),
  commits: z.array(StripCommitSchema),
  baseSha: z.string(),
  headSha: z.string(),
  /** The PR's head on GitHub when it moved past the head read: a new revision to read. */
  newRevision: z.string().nullable(),
  /** Who decided: `✓ ada approved · ✗ cy requested changes` (bad while one asks changes). */
  reviews: z.strictObject({ label: z.string(), hue: z.enum(['good', 'warn', 'bad']) }).nullable(),
  /** `3 new`: comments GitHub had that the person has not looked at yet; none when none. */
  fresh: z.string().nullable(),
  /** The files in scope, how many are reviewed, and their counts. */
  files: z.number().int(),
  reviewed: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** The files pane's count (`6 files · 2 reviewed · 1 draft`) or what blocks Submit review. */
  filesLabel: z.string(),
  /** Submit review is open: drafts or a verdict to send, none outdated, the PR open. */
  canSubmit: z.boolean(),
});
export type Strip = z.infer<typeof StripSchema>;

/** A draft waiting to go, where it sits: the diff's gutter marks the line. */
const DraftedSchema = z.strictObject({
  seq: z.number().int(),
  path: z.string(),
  side: Side,
  line: z.number().int(),
  body: z.string(),
  head: z.string().nullable(),
  outdated: z.boolean(),
});

const ThreadSchema = z.strictObject({
  id: z.string(),
  path: z.string(),
  side: Side,
  line: z.number().int().nullable(),
  start: z.number().int().nullable(),
  head: z.string(),
  outdated: z.boolean(),
  resolved: z.boolean(),
  canReply: z.boolean(),
  canResolve: z.boolean(),
  comments: z.array(
    z.strictObject({ id: z.number().int(), author: z.string(), body: z.string(), url: z.string() }),
  ),
  /** Your reply kept for it: its text, tried and unconfirmed, why it did not go. */
  reply: z
    .strictObject({ body: z.string(), unconfirmed: z.boolean(), error: z.string().nullable() })
    .nullable(),
});

/** A row of the files pane's right-click menu: what it runs, its key, its label, grey or not. */
const MenuRowSchema = z.strictObject({
  run: z.string(),
  key: z.string(),
  label: z.string(),
  enabled: z.boolean(),
});

/** A lifecycle row of the Log's PR menu (Mark ready, Merge…, Close…): grey with why. */
const LifecycleSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  reason: z.string().nullable(),
});

export const ReviewPaneSchema = z.strictObject({
  kind: z.literal('ReviewPane'),
  id: z.string().optional(),
  props: z.strictObject({
    /** Which review: the checkout it is read in, the PR. */
    root: z.string(),
    number: z.number().int(),
    title: z.string(),
    /** The pane's line under its header: the read's progress or why it failed, its tone. */
    said: z.string(),
    tone: Tone,
    /** By heat (else by folder) is the order. */
    heat: z.boolean(),
    /** Only the files changed since your review are listed. */
    since: z.boolean(),
    lines: z.array(PaneLineSchema),
    /** The cursor's line. */
    at: z.number().int().nullable(),
    drafted: z.array(DraftedSchema),
    threads: z.array(ThreadSchema),
    threadsNote: z.string().nullable(),
    /** The verdict and summary kept for Submit review (GitHub's event). */
    saved: z
      .strictObject({
        head: z.string(),
        verdict: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
        body: z.string(),
      })
      .nullable(),
    strip: StripSchema.nullable(),
    /**
     * The PR's conversation under its description, oldest first: comments and the reviews sent
     * with a verdict or a summary; `when` as the person reads it (`2 h ago`).
     */
    conversation: z.array(
      z.strictObject({
        kind: z.enum(['comment', 'approved', 'changes', 'commented', 'dismissed']),
        author: z.string(),
        body: z.string(),
        when: z.string(),
      }),
    ),
    menu: z.array(MenuRowSchema),
    lifecycle: z.array(LifecycleSchema),
  }),
});
export type ReviewPaneNode = z.infer<typeof ReviewPaneSchema>;
export type ReviewPaneProps = ReviewPaneNode['props'];

export const REVIEW_KINDS = ['ReviewPane'] as const;

export const reviewSchemas = () => [ReviewPaneSchema] as const;
