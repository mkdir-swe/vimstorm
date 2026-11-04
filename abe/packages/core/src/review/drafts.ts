/**
 * Review comments and the verdict: a comment drafted on a line of the PR's diff is kept in
 * `drafts/<pr>` (1.x's shape) until a review takes it; a review goes with the drafts on the head
 * that was read, refused when the PR's head moved; drafts sent carry the head they went out on,
 * so none goes twice. A submission's identity is kept before it is sent, so a retry only
 * reconciles.
 */
import { z } from 'zod';
import { shortSha } from '../board/pipelines';
import { baseName } from './changes';
import { hash, stableJson } from './hash';
import { parsePatch, type Side } from './hunks';

export const SideSchema = z.enum(['LEFT', 'RIGHT']);

/** A line on one side of the diff. */
export const LineRef = z.looseObject({ side: SideSchema, line: z.number().int() });
export type LineRef = z.infer<typeof LineRef>;

/** Where a comment goes: a line, or the lines from `start` to it on one side. */
export type Target = { path: string; line: LineRef; start?: LineRef | undefined };

/** A review comment drafted on a line, kept until it goes out with a review. */
export const Draft = z.looseObject({
  /** Its number among the PR's drafts, which names it. */
  seq: z.number().int(),
  path: z.string(),
  line: LineRef,
  start: LineRef.optional(),
  body: z.string(),
  /** The head commit of the review it went out with; none while it waits. */
  sent: z.string().optional(),
  /** The revision seen when it was written; a legacy draft has none. */
  head: z.string().optional(),
});
export type Draft = z.infer<typeof Draft>;

/** A reply to a posted discussion, kept before it goes and until GitHub confirms it. */
export const ReplyDraft = z.looseObject({
  id: z.string(),
  thread: z.string(),
  comment_id: z.number().int(),
  body: z.string(),
  attempted: z.boolean(),
  confirmed: z.boolean(),
  error: z.string().nullable().optional(),
});
export type ReplyDraft = z.infer<typeof ReplyDraft>;

/** A review (or a comment posted now) kept before it is sent: a retry only reconciles it. */
export const Submission = z.looseObject({
  id: z.string(),
  key: z.string(),
  attempted: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  head: z.string().default(''),
  seqs: z.array(z.number().int()).default([]),
});
export type Submission = z.infer<typeof Submission>;

/** GitHub's review events, as the drafts doc names them. */
export const REVIEW_VERDICTS = ['Comment', 'RequestChanges', 'Approve'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** The verdict and summary last chosen, on the head they were written for. */
export const ReviewSummary = z.looseObject({
  head: z.string(),
  verdict: z.enum(REVIEW_VERDICTS),
  body: z.string(),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;

/** A PR's drafts as kept, with when they were written (ms). Fields another writer added stay. */
export const Drafts = z.looseObject({
  reply: ReplyDraft.optional(),
  submission: Submission.optional(),
  review: ReviewSummary.optional(),
  at: z.number().optional(),
  drafts: z.array(Draft).default([]),
});
export type Drafts = z.infer<typeof Drafts>;

export const NO_DRAFTS: Drafts = { drafts: [] };

/** A verdict's words and GitHub's `event`. */
export const VERDICT_LABEL: Readonly<Record<ReviewVerdict, string>> = {
  Comment: 'Comment',
  RequestChanges: 'Request changes',
  Approve: 'Approve',
};
export const VERDICT_EVENT: Readonly<Record<ReviewVerdict, string>> = {
  Comment: 'COMMENT',
  RequestChanges: 'REQUEST_CHANGES',
  Approve: 'APPROVE',
};

export const verdictOfEvent = (event: string): ReviewVerdict | undefined =>
  REVIEW_VERDICTS.find((v) => VERDICT_EVENT[v] === event);

export const plural = (n: number, noun: string): string =>
  n === 1 ? `1 ${noun}` : `${n} ${noun}s`;

/** The drafts not sent yet. */
export const unsent = (drafts: readonly Draft[]): Draft[] =>
  drafts.filter((d) => d.sent === undefined);

export const targetOf = (d: Draft): Target => ({
  path: d.path,
  line: d.line,
  ...(d.start === undefined ? {} : { start: d.start }),
});

const sameLine = (a: LineRef | undefined, b: LineRef | undefined) =>
  a?.side === b?.side && a?.line === b?.line;

export const sameTarget = (a: Target, b: Target): boolean =>
  a.path === b.path && sameLine(a.line, b.line) && sameLine(a.start, b.start);

export type Changed = { drafts: Draft[]; said: string };

/** A draft added on `target` and what the status says; none for an empty comment. */
export const addDraft = (
  drafts: readonly Draft[],
  target: Target,
  body: string,
  head: string,
): Changed | undefined => {
  const text = body.trim();

  if (text === '') return undefined;
  const seq = Math.max(0, ...drafts.map((d) => d.seq)) + 1;
  const next: Draft[] = [
    ...drafts,
    {
      seq,
      path: target.path,
      line: target.line,
      ...(target.start === undefined ? {} : { start: target.start }),
      body: text,
      head,
    },
  ];

  return {
    drafts: next,
    said: `✎ Draft on ${baseName(target.path)}:${target.line.line} · ,is submits ${plural(unsent(next).length, 'draft')} in one review`,
  };
};

/** The latest unsent draft on `path` dropped, and what the status says; none when it has none. */
export const dropDraft = (drafts: readonly Draft[], path: string): Changed | undefined => {
  const last = [...drafts].reverse().find((d) => d.sent === undefined && d.path === path);

  if (last === undefined) return undefined;

  return {
    drafts: drafts.filter((d) => d.seq !== last.seq),
    said: `Draft on ${baseName(path)}:${last.line.line} dropped`,
  };
};

/** Draft `seq` deleted (a card's Delete…), and what the status says; none when it is not waiting. */
export const deleteDraft = (drafts: readonly Draft[], seq: number): Changed | undefined => {
  const d = drafts.find((x) => x.seq === seq && x.sent === undefined);

  if (d === undefined) return undefined;

  return {
    drafts: drafts.filter((x) => x.seq !== seq),
    said: `Draft on ${baseName(d.path)}:${d.line.line} deleted`,
  };
};

/**
 * Draft `seq`'s text replaced (a card's Edit draft), its anchor and revision kept; none for an
 * empty text or a draft not waiting.
 */
export const editDraft = (
  drafts: readonly Draft[],
  seq: number,
  body: string,
): Changed | undefined => {
  const text = body.trim();

  if (text === '') return undefined;
  const d = drafts.find((x) => x.seq === seq && x.sent === undefined);

  if (d === undefined) return undefined;

  return {
    drafts: drafts.map((x) => (x.seq === seq ? { ...x, body: text } : x)),
    said: `✎ Draft on ${baseName(d.path)}:${d.line.line} edited`,
  };
};

/**
 * Whether GitHub takes a comment on `target`: the lines of its side a patch's hunks cover
 * (context and changes); a range must sit wholly inside one hunk, on one side.
 */
export const onDiff = (patch: string, target: Target): boolean => {
  const side: Side = target.line.side;
  const start = target.start?.line ?? target.line.line;

  if (start === 0 || start > target.line.line) return false;
  if (target.start !== undefined && target.start.side !== side) return false;

  return parsePatch(patch).some((h) => {
    const lines = h.rows.flatMap((r) => {
      const n = side === 'LEFT' ? r.left : r.right;

      return n === undefined ? [] : [n];
    });

    return lines.includes(start) && lines.includes(target.line.line);
  });
};

/** The PR a review goes to, as the send needs it. */
export type ReviewTarget = {
  number: number;
  /** The PR's head on GitHub now. */
  head: string;
  /** The head its changes were read at: the drafts' lines are on it. */
  read: string;
  draft: boolean;
  /** Opened by whoever gh is signed in as. */
  own: boolean;
};

/**
 * The verdicts a review may have, Comment first: GitHub refuses approving or requesting changes
 * on your own PR, and a draft PR is not approved.
 */
export const verdicts = (own: boolean, draft: boolean): ReviewVerdict[] => {
  if (own) return ['Comment'];

  return draft ? ['Comment', 'RequestChanges'] : ['Comment', 'RequestChanges', 'Approve'];
};

/** A review comment as GitHub takes it. */
export type ReviewComment = {
  path: string;
  line: number;
  side: Side;
  start?: LineRef | undefined;
  body: string;
};

/** One review: `POST pulls/<pr>/reviews`. */
export type ReviewOut = {
  /** Its submission's identity (the drafts doc's), which marks it on GitHub. */
  submission: string;
  /** A retry: only look for it on GitHub, never post it again. */
  reconcileOnly: boolean;
  pr: number;
  commit: string;
  verdict: ReviewVerdict;
  body?: string | undefined;
  comments: ReviewComment[];
};

/** A review's identity from what it holds; whether it is a try or a retry never changes it. */
export const submissionKey = (review: ReviewOut, immediate: boolean): string =>
  hash(
    stableJson({
      version: 1,
      immediate,
      pr: review.pr,
      head: review.commit,
      verdict: VERDICT_EVENT[review.verdict],
      body: review.body ?? null,
      comments: review.comments.map((c) => ({
        path: c.path,
        side: c.side,
        line: c.line,
        start_side: c.start?.side ?? null,
        start_line: c.start?.line ?? null,
        body: c.body,
      })),
    }),
  );

/** A review ready to send and the drafts it carries. */
export type ReviewPlan = {
  review: ReviewOut;
  /** The drafts it carries, by `seq`. */
  seqs: number[];
  /** The status while it goes, once it went, and the start of a failure's. */
  saying: string;
  said: string;
  failed: string;
};

export type Tone = 'info' | 'ok' | 'warn' | 'error';

export type ReviewRefusal = { why: string; tone: Tone };

/**
 * The review the unsent drafts go out in with `verdict` and `body`, or why it cannot go: a
 * verdict the PR does not allow, Comment or Request changes with neither a body nor a draft, or
 * the PR's head moved since its changes were read (drafts or not: the verdict is on what was
 * seen). Drafts already sent never go again.
 */
export const reviewPlan = (
  drafts: readonly Draft[],
  verdict: ReviewVerdict,
  body: string,
  pr: ReviewTarget,
): { ok: true; plan: ReviewPlan } | ({ ok: false } & ReviewRefusal) => {
  const going = unsent(drafts);
  const text = body.trim();
  const label = VERDICT_LABEL[verdict];

  if (!verdicts(pr.own, pr.draft).includes(verdict)) {
    const whose = pr.own ? 'your own PR' : 'a draft PR';

    return { ok: false, why: `${label} is not for ${whose}`, tone: 'warn' };
  }
  if (verdict !== 'Approve' && text === '' && going.length === 0)
    return { ok: false, why: `${label} needs a body or a draft comment`, tone: 'warn' };
  // a verdict goes on what was read only, drafts or not
  if (pr.read !== pr.head) {
    const why =
      going.length === 0 ? 'Read Again in its menu reads it again' : 'the lines may be off';

    return {
      ok: false,
      why: `✗ Read at ${shortSha(pr.read)}, the PR is at ${shortSha(pr.head)}: ${why}, not sent`,
      tone: 'error',
    };
  }
  if (going.some((d) => d.head !== pr.read))
    return {
      ok: false,
      why: '✗ Outdated draft comments kept on their original revision; remove or rewrite them before submitting',
      tone: 'error',
    };
  const n = pr.number;

  return {
    ok: true,
    plan: {
      review: {
        submission: '',
        reconcileOnly: false,
        pr: n,
        commit: pr.head,
        verdict,
        ...(text === '' ? {} : { body: text }),
        comments: going.map((d) => ({
          path: d.path,
          line: d.line.line,
          side: d.line.side,
          ...(d.start === undefined ? {} : { start: d.start }),
          body: d.body,
        })),
      },
      seqs: going.map((d) => d.seq),
      saying: `Sending ${label} to PR #${n}…`,
      said:
        going.length === 0
          ? `✓ ${label} sent to PR #${n}`
          : `✓ ${label} sent to PR #${n}, ${plural(going.length, 'comment')} in one review`,
      failed: '✗ Review submission unconfirmed, drafts kept',
    },
  };
};

/** The drafts with those of `seqs` marked sent with the review on `head`. */
export const markSent = (
  drafts: readonly Draft[],
  seqs: readonly number[],
  head: string,
): Draft[] => drafts.map((d) => (seqs.includes(d.seq) ? { ...d, sent: head } : d));

/** The drafts with those of `seqs` that were marked sent on `head` waiting again. */
export const unmarkSent = (
  drafts: readonly Draft[],
  seqs: readonly number[],
  head: string,
): Draft[] =>
  drafts.map((d) => {
    if (!seqs.includes(d.seq) || d.sent !== head) return d;
    const waiting: Draft = { ...d };

    delete waiting.sent;

    return waiting;
  });
