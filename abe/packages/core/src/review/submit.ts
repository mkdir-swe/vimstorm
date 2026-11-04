/**
 * A review's, a comment posted now's and a discussion reply's way out, as changes to the drafts
 * doc: each is kept with its identity before it goes, marked confirmed once GitHub took it, and
 * released (its drafts waiting again) when it did not. Serve runs the steps with GitHub between
 * them; these say what each step writes.
 */
import {
  addDraft,
  type Draft,
  type Drafts,
  markSent,
  type ReviewRefusal,
  type ReplyDraft,
  reviewPlan,
  type ReviewPlan,
  type ReviewTarget,
  sameTarget,
  type Submission,
  submissionKey,
  type Target,
  unmarkSent,
  unsent,
  type ReviewVerdict,
} from './drafts';
import { hash } from './hash';

/**
 * A PR's drafts as they stand: a submission GitHub has not confirmed leaves its drafts waiting
 * (only a confirmed one sent them).
 */
export const draftsOf = (doc: Drafts): Drafts => {
  const s = doc.submission;

  return s === undefined || s.confirmed
    ? doc
    : { ...doc, drafts: unmarkSent(doc.drafts, s.seqs, s.head) };
};

/** A write's `at`: after the doc's and the clock's. */
export const bumped = (doc: Drafts, now: number): number => Math.max(doc.at ?? 0, now) + 1;

/** A submission tried and not confirmed: only reconciling it may go next. */
export const unconfirmed = (doc: Drafts): Submission | undefined =>
  doc.submission?.attempted === true && !doc.submission.confirmed ? doc.submission : undefined;

type Step<T> = ({ ok: true } & T) | ({ ok: false } & ReviewRefusal);

/**
 * A verdict chosen (`,ia` / `,ir` / `,is`): kept on the head read before the PR's head is read
 * anew; refused while another submission is unconfirmed.
 */
export const chooseVerdict = (
  doc: Drafts,
  verdict: ReviewVerdict,
  body: string,
  read: string,
  now: number,
): Step<{ doc: Drafts }> => {
  const drafts = draftsOf(doc);
  const saved = drafts.review;

  if (unconfirmed(drafts) !== undefined && !(saved?.verdict === verdict && saved.body === body))
    return {
      ok: false,
      why: 'An earlier submission is unconfirmed; reconcile its original review or comment before starting another',
      tone: 'warn',
    };

  return {
    ok: true,
    doc: { ...drafts, review: { head: read, verdict, body }, at: bumped(drafts, now) },
  };
};

/** The submission a plan goes out as: the unconfirmed one with its key again, else a new one. */
const submissionFor = (
  drafts: Drafts,
  plan: ReviewPlan,
  key: string,
  now: number,
): { submission: Submission; plan: ReviewPlan } => {
  const kept = drafts.submission;
  const base: Submission =
    kept?.key === key && !kept.confirmed
      ? kept
      : {
          id: `${(drafts.at ?? now) + 1}-${key}`,
          key,
          attempted: false,
          confirmed: false,
          head: plan.review.commit,
          seqs: plan.seqs,
        };

  return {
    submission: { ...base, attempted: true, confirmed: false },
    plan: {
      ...plan,
      review: { ...plan.review, reconcileOnly: base.attempted, submission: base.id },
    },
  };
};

/**
 * The PR's head read anew: the review planned on it and claimed (its drafts marked sent, its
 * submission kept as tried), or refused with the doc to keep. An unconfirmed submission is
 * reconciled on the head it was made on, with its own drafts.
 */
export const claimVerdict = (
  doc: Drafts,
  verdict: ReviewVerdict,
  body: string,
  pr: ReviewTarget,
  now: number,
): { ok: true; doc: Drafts; plan: ReviewPlan } | ({ ok: false; doc: Drafts } & ReviewRefusal) => {
  const drafts = draftsOf(doc);
  const open = unconfirmed(drafts);
  const target: ReviewTarget =
    open === undefined ? pr : { ...pr, head: open.head, read: open.head };
  const reviewed: Drafts = { ...drafts, review: { head: target.read, verdict, body } };
  const going: Draft[] =
    open === undefined ? reviewed.drafts : reviewed.drafts.filter((d) => open.seqs.includes(d.seq));
  const planned = reviewPlan(going, verdict, body, target);

  if (!planned.ok)
    return {
      ok: false,
      doc: { ...reviewed, at: bumped(reviewed, now) },
      why: planned.why,
      tone: planned.tone,
    };
  const { submission, plan } = submissionFor(
    reviewed,
    planned.plan,
    submissionKey(planned.plan.review, false),
    now,
  );

  return {
    ok: true,
    plan,
    doc: {
      ...reviewed,
      submission,
      at: bumped(reviewed, now),
      drafts: markSent(reviewed.drafts, plan.seqs, plan.review.commit),
    },
  };
};

/**
 * A comment to post now, kept first as a draft on the revision it was typed on (once: the same
 * draft waiting already is it).
 */
export const keepPostNow = (
  doc: Drafts,
  target: Target,
  body: string,
  head: string,
  now: number,
): Drafts | undefined => {
  const drafts = draftsOf(doc);
  const text = body.trim();

  if (text === '') return undefined;
  const there = unsent(drafts.drafts).some(
    (d) => sameTarget(d, target) && d.body === text && d.head === head,
  );
  const next = there ? drafts.drafts : addDraft(drafts.drafts, target, text, head)?.drafts;

  return next === undefined ? undefined : { ...drafts, drafts: next, at: bumped(drafts, now) };
};

/**
 * The PR's head read anew for a comment posted now: claimed as a one-comment review on the head it
 * was typed on, or refused (the comment stays a draft). `doc` absent: nothing to write.
 */
export const claimPostNow = (
  doc: Drafts,
  target: Target,
  body: string,
  head: string,
  prHead: string,
  number: number,
  now: number,
):
  | { ok: true; doc: Drafts; plan: ReviewPlan }
  | ({ ok: false; doc?: Drafts | undefined } & ReviewRefusal) => {
  const drafts = draftsOf(doc);
  const text = body.trim();
  let list = drafts.drafts;
  let one = unsent(list).find((d) => sameTarget(d, target) && d.body === text && d.head === head);

  if (one === undefined) {
    const added = addDraft(list, target, text, head);

    if (added === undefined) return { ok: false, why: 'Nothing to post', tone: 'warn' };
    list = added.drafts;
    one = list.at(-1);
  }
  if (one === undefined) return { ok: false, why: 'Nothing to post', tone: 'warn' };
  const withOne: Drafts = { ...drafts, drafts: list };
  const planned = reviewPlan([one], 'Comment', '', {
    number,
    head: prHead,
    read: head,
    draft: false,
    own: false,
  });

  if (!planned.ok)
    return {
      ok: false,
      doc: { ...withOne, at: bumped(withOne, now) },
      why: `${planned.why}; comment kept as a draft`,
      tone: planned.tone,
    };
  const posting: ReviewPlan = {
    ...planned.plan,
    saying: 'Posting comment now…',
    said: 'Comment posted; pending review kept',
  };
  const key = submissionKey(posting.review, true);
  const open = unconfirmed(withOne);

  if (open !== undefined && open.key !== key)
    return {
      ok: false,
      why: 'An earlier submission is unconfirmed; retry its original review or comment first. New comment kept as a draft',
      tone: 'warn',
    };
  const { submission, plan } = submissionFor(withOne, posting, key, now);

  return {
    ok: true,
    plan,
    doc: {
      ...withOne,
      submission,
      at: bumped(withOne, now),
      drafts: markSent(withOne.drafts, plan.seqs, plan.review.commit),
    },
  };
};

/** GitHub took it: its drafts sent for good, the submission confirmed (a review's verdict gone). */
export const sentDoc = (doc: Drafts, postNow: boolean, now: number): Drafts => {
  const drafts = draftsOf(doc);
  const s = drafts.submission;
  const confirmed: Drafts =
    s === undefined
      ? drafts
      : {
          ...drafts,
          drafts: markSent(drafts.drafts, s.seqs, s.head),
          submission: { ...s, confirmed: true },
        };
  const next: Drafts = { ...confirmed, at: bumped(drafts, now) };

  if (!postNow) delete next.review;

  return next;
};

/** Error codes that say GitHub surely refused it: a retry may post again. */
export const REJECTED = ['auth', 'invalid', 'refused', 'conflict', 'precondition'] as const;

/**
 * It did not go (or GitHub did not confirm it): its drafts waiting again; a sure refusal of a
 * first try lets the next one post anew, anything else only reconciles.
 */
export const releasedDoc = (doc: Drafts, plan: ReviewPlan, code: string, now: number): Drafts => {
  const drafts = draftsOf(doc);
  const rejected = !plan.review.reconcileOnly && REJECTED.some((r) => r === code);
  const s = drafts.submission;

  return {
    ...drafts,
    ...(s === undefined ? {} : { submission: rejected ? { ...s, attempted: false } : s }),
    at: bumped(drafts, now),
    drafts: unmarkSent(drafts.drafts, plan.seqs, plan.review.commit),
  };
};

/** A posted discussion as a reply needs it. */
export type ReplyThread = { id: string; canReply: boolean; firstComment: number };

/**
 * A reply to `thread` kept before it goes: the unconfirmed one again (the same text), else a new
 * one; refused while another unconfirmed reply holds different text. `permitted` false: GitHub
 * lets you not reply there, the reply kept with why.
 */
export const keepReply = (
  doc: Drafts,
  thread: ReplyThread,
  body: string,
  number: number,
  now: number,
): Step<{ doc: Drafts; reply: ReplyDraft; permitted: boolean; reconcileOnly: boolean }> => {
  const drafts = draftsOf(doc);
  const text = body.trim();
  const held = drafts.reply;

  if (
    held !== undefined &&
    held.attempted &&
    !held.confirmed &&
    (held.thread !== thread.id || held.body !== text)
  )
    return {
      ok: false,
      why: 'An earlier reply is unconfirmed; reconcile its retained original text before editing or posting another reply',
      tone: 'warn',
    };
  const at = bumped(drafts, now);
  const again =
    held !== undefined && !held.confirmed && held.thread === thread.id && held.body === text
      ? held
      : undefined;
  const base: ReplyDraft = again ?? {
    id: `${at}-${hash(`${number}:${thread.id}:${thread.firstComment}:${text}`)}`,
    thread: thread.id,
    comment_id: thread.firstComment,
    body: text,
    attempted: false,
    confirmed: false,
    error: null,
  };
  const reconcileOnly = base.attempted;
  const permitted = thread.canReply || reconcileOnly;
  const reply: ReplyDraft = {
    ...base,
    attempted: permitted,
    error: permitted ? null : 'GitHub does not permit replying to this discussion',
  };

  return { ok: true, doc: { ...drafts, reply, at }, reply, permitted, reconcileOnly };
};

/** The reply GitHub confirmed. */
export const replySentDoc = (doc: Drafts, id: string, now: number): Drafts => {
  const drafts = draftsOf(doc);
  const r = drafts.reply;

  return {
    ...drafts,
    ...(r?.id === id ? { reply: { ...r, confirmed: true, error: null } } : {}),
    at: bumped(drafts, now),
  };
};

/**
 * The reply not confirmed: kept with why; one surely refused (or never sent) may go anew,
 * anything else only reconciles.
 */
export const replyFailedDoc = (
  doc: Drafts,
  id: string,
  rejected: boolean,
  message: string,
  now: number,
): Drafts => {
  const drafts = draftsOf(doc);
  const r = drafts.reply;

  return {
    ...drafts,
    ...(r?.id === id
      ? { reply: { ...r, ...(rejected ? { attempted: false } : {}), error: message } }
      : {}),
    at: bumped(drafts, now),
  };
};
