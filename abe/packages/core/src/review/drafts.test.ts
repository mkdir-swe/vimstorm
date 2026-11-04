/**
 * Review comments and the verdict (1.x's `crates/abe-core/tests/drafts.rs`): drafts numbered and
 * kept until they go, one review with the drafts on the head that was read, refused when the PR's
 * head moved, drafts never sent twice; a comment only on a line of the PR's diff; and the
 * submission's way out kept in the doc, so a retry only reconciles.
 */
import { describe, expect, test } from 'bun:test';
import {
  addDraft,
  type Draft,
  type Drafts,
  dropDraft,
  editDraft,
  deleteDraft,
  type LineRef,
  markSent,
  onDiff,
  reviewPlan,
  type ReviewTarget,
  type ReviewVerdict,
  type Side,
  type Target,
  unmarkSent,
  unsent,
  verdicts,
  VERDICT_EVENT,
} from '.';
import {
  chooseVerdict,
  claimPostNow,
  claimVerdict,
  draftsOf,
  keepPostNow,
  keepReply,
  releasedDoc,
  replyFailedDoc,
  replySentDoc,
  sentDoc,
} from './submit';

const at = (side: Side, line: number): LineRef => ({ side, line });

const draft = (seq: number, path: string, line: LineRef, body: string, sent?: string): Draft => ({
  seq,
  path,
  line,
  body,
  head: 'head111',
  ...(sent === undefined ? {} : { sent }),
});

const pr = (more: Partial<ReviewTarget> = {}): ReviewTarget => ({
  number: 7,
  head: 'head111',
  read: 'head111',
  draft: false,
  own: false,
  ...more,
});

const drafts = (): Draft[] => [
  draft(1, 'a.ts', at('RIGHT', 3), 'why?'),
  draft(2, 'b.ts', at('LEFT', 9), 'old', 'head000'),
];

/** A plan as one line: the verdict, the commit, the body and the comments; or why not. */
const plan = (
  verdict: ReviewVerdict,
  body: string,
  more: Partial<ReviewTarget>,
  withDrafts: Draft[],
): string => {
  const p = reviewPlan(withDrafts, verdict, body, pr(more));

  if (!p.ok) return p.why;
  const r = p.plan.review;

  return `${VERDICT_EVENT[r.verdict]} @${r.commit} ${r.body ?? '-'} [${r.comments.map((c) => `${c.path}:${c.line}`).join(' ')}]`;
};

describe('the verdict', () => {
  test('the verdicts GitHub takes, and words for all but an approval', () => {
    expect(verdicts(false, false)).toEqual(['Comment', 'RequestChanges', 'Approve']);
    expect(verdicts(false, true)).toEqual(['Comment', 'RequestChanges']);
    expect(verdicts(true, false)).toEqual(['Comment']);
    const all = drafts();
    const old = { read: 'head000' };

    expect([
      plan('Comment', '', {}, all),
      plan('RequestChanges', ' Fix the guard ', {}, all),
      plan('Approve', '', {}, all),
      plan('Approve', '', {}, []),
      plan('Comment', '', {}, []),
      plan('RequestChanges', '', {}, []),
      plan('Comment', 'Looks fine', {}, []),
      plan('Approve', '', { own: true }, all),
      plan('RequestChanges', 'no', { own: true }, all),
      plan('Approve', '', { draft: true }, all),
      plan('Comment', '', old, all),
      plan('Approve', '', old, []),
      plan('RequestChanges', 'no', old, []),
      plan('Comment', 'Looks fine', old, []),
    ]).toEqual([
      'COMMENT @head111 - [a.ts:3]',
      'REQUEST_CHANGES @head111 Fix the guard [a.ts:3]',
      'APPROVE @head111 - [a.ts:3]',
      'APPROVE @head111 - []',
      'Comment needs a body or a draft comment',
      'Request changes needs a body or a draft comment',
      'COMMENT @head111 Looks fine []',
      'Approve is not for your own PR',
      'Request changes is not for your own PR',
      'Approve is not for a draft PR',
      '✗ Read at head000, the PR is at head111: the lines may be off, not sent',
      // a verdict on what was read only, drafts or not
      '✗ Read at head000, the PR is at head111: Read Again in its menu reads it again, not sent',
      '✗ Read at head000, the PR is at head111: Read Again in its menu reads it again, not sent',
      '✗ Read at head000, the PR is at head111: Read Again in its menu reads it again, not sent',
    ]);
  });

  test('a moved head refuses the drafts as an error, and a plan says what it sends', () => {
    const moved = reviewPlan(drafts(), 'Approve', '', pr({ head: 'head222' }));

    expect(moved).toEqual({
      ok: false,
      why: '✗ Read at head111, the PR is at head222: the lines may be off, not sent',
      tone: 'error',
    });
    const p = reviewPlan(drafts(), 'RequestChanges', 'Fix it', pr());

    if (!p.ok) throw new Error(p.why);
    expect(p.plan.saying).toBe('Sending Request changes to PR #7…');
    expect(p.plan.said).toBe('✓ Request changes sent to PR #7, 1 comment in one review');
    expect(p.plan.failed).toBe('✗ Review submission unconfirmed, drafts kept');
    expect(p.plan.review.comments).toEqual([
      { path: 'a.ts', side: 'RIGHT', line: 3, body: 'why?' },
    ]);
    const none = reviewPlan([], 'Approve', '', pr());

    expect(none.ok && none.plan.said).toBe('✓ Approve sent to PR #7');
  });

  test('drafts are cleared once sent and never go twice', () => {
    const p = reviewPlan(drafts(), 'Comment', '', pr());

    if (!p.ok) throw new Error(p.why);
    expect(p.plan.seqs).toEqual([1]);
    const sent = markSent(drafts(), p.plan.seqs, p.plan.review.commit);

    expect(sent.map((d) => d.sent)).toEqual(['head111', 'head000']);
    expect(unsent(sent)).toEqual([]);
    expect(reviewPlan(sent, 'Comment', '', pr())).toEqual({
      ok: false,
      why: 'Comment needs a body or a draft comment',
      tone: 'warn',
    });
    // the review failed: they wait again
    expect(unmarkSent(sent, p.plan.seqs, 'head111')).toEqual(drafts());
  });

  test("refreshing the PR never moves an existing draft's anchor to the new head", () => {
    const target: Target = { path: 'a.ts', line: at('RIGHT', 3) };
    const kept = addDraft([], target, 'on the old code', 'head111')?.drafts ?? [];

    expect(reviewPlan(kept, 'Comment', '', pr({ head: 'head222', read: 'head222' })).ok).toBe(
      false,
    );
  });
});

describe('drafts', () => {
  test('a draft is numbered after the others, and an empty one is none', () => {
    const target: Target = {
      path: 'src/login.ts',
      line: at('RIGHT', 12),
      start: at('RIGHT', 10),
    };
    const added = addDraft(drafts(), target, '  Guard this?  ', 'head111');

    expect(added?.drafts.length).toBe(3);
    expect(added?.drafts[2]).toEqual({
      seq: 3,
      path: 'src/login.ts',
      line: at('RIGHT', 12),
      start: at('RIGHT', 10),
      body: 'Guard this?',
      head: 'head111',
    });
    expect(added?.said).toBe('✎ Draft on login.ts:12 · ,is submits 2 drafts in one review');
    expect(addDraft(drafts(), target, '  ', 'head111')).toBeUndefined();
    const one = addDraft([], target, 'x', 'head111');

    expect(one?.drafts[0]?.seq).toBe(1);
    expect(one?.said).toBe('✎ Draft on login.ts:12 · ,is submits 1 draft in one review');
  });

  test("a comment goes only on a line of the PR's diff", () => {
    // base lines 3–5, head lines 3–6: `-a +b +c` amid context
    const patch = '@@ -3,3 +3,4 @@\n x\n-a\n+b\n+c\n y';
    const t = (side: Side, line: number, start?: LineRef): Target => ({
      path: 'f.ts',
      line: at(side, line),
      ...(start === undefined ? {} : { start }),
    });

    expect(onDiff(patch, t('RIGHT', 3))).toBe(true);
    expect(onDiff(patch, t('RIGHT', 5))).toBe(true);
    expect(onDiff(patch, t('RIGHT', 6))).toBe(true);
    expect(onDiff(patch, t('RIGHT', 7))).toBe(false);
    expect(onDiff(patch, t('RIGHT', 2))).toBe(false);
    expect(onDiff(patch, t('LEFT', 4))).toBe(true);
    expect(onDiff(patch, t('LEFT', 6))).toBe(false);
    expect(onDiff(patch, t('RIGHT', 6, at('RIGHT', 2)))).toBe(false);
    expect(onDiff(patch, t('RIGHT', 6, at('RIGHT', 4)))).toBe(true);
    expect(onDiff(patch, t('RIGHT', 6, at('LEFT', 4)))).toBe(false);
  });

  test('drop takes the latest unsent draft on the file; delete and edit name one by number', () => {
    const list = [...drafts(), draft(3, 'a.ts', at('RIGHT', 8), 'and this')];
    const dropped = dropDraft(list, 'a.ts');

    expect(dropped?.said).toBe('Draft on a.ts:8 dropped');
    expect(dropped?.drafts.map((d) => d.seq)).toEqual([1, 2]);
    // b.ts's only draft went out already
    expect(dropDraft(list, 'b.ts')).toBeUndefined();
    expect(dropDraft(list, 'c.ts')).toBeUndefined();
    expect(deleteDraft(list, 1)?.said).toBe('Draft on a.ts:3 deleted');
    expect(deleteDraft(list, 2)).toBeUndefined();
    expect(editDraft(list, 3, ' sharper ')?.drafts[2]).toEqual({
      ...draft(3, 'a.ts', at('RIGHT', 8), 'sharper'),
    });
    expect(editDraft(list, 3, ' ')).toBeUndefined();
  });
});

describe('the way out', () => {
  const doc = (more: Partial<Drafts> = {}): Drafts => ({ at: 10, drafts: drafts(), ...more });

  test('a review is claimed with its identity, confirmed once sent, its verdict then gone', () => {
    const chosen = chooseVerdict(doc(), 'Approve', 'ship it', 'head111', 100);

    if (!chosen.ok) throw new Error(chosen.why);
    expect(chosen.doc.review).toEqual({ head: 'head111', verdict: 'Approve', body: 'ship it' });
    expect(chosen.doc.at).toBe(101);
    const claimed = claimVerdict(chosen.doc, 'Approve', 'ship it', pr(), 200);

    if (!claimed.ok) throw new Error(claimed.why);
    expect(claimed.plan.review.submission).toMatch(/^102-[0-9a-f]{14}$/);
    expect(claimed.plan.review.reconcileOnly).toBe(false);
    expect(claimed.doc.submission).toMatchObject({
      attempted: true,
      confirmed: false,
      head: 'head111',
      seqs: [1],
    });
    // while unconfirmed its drafts still wait
    expect(unsent(draftsOf(claimed.doc).drafts).map((d) => d.seq)).toEqual([1]);
    const sent = sentDoc(claimed.doc, false, 300);

    expect(sent.submission?.confirmed).toBe(true);
    expect(unsent(draftsOf(sent).drafts)).toEqual([]);
    expect(sent.review).toBeUndefined();
  });

  test('a retry of an unconfirmed review only reconciles it, on its own head and drafts', () => {
    const claimed = claimVerdict(doc(), 'Comment', '', pr(), 200);

    if (!claimed.ok) throw new Error(claimed.why);
    // not confirmed (a lost answer): the drafts wait, the submission stays tried
    const lost = releasedDoc(claimed.doc, claimed.plan, 'failed', 300);

    expect(lost.submission?.attempted).toBe(true);
    // another verdict is refused while it is unconfirmed
    expect(chooseVerdict(lost, 'Approve', '', 'head111', 400)).toMatchObject({ ok: false });
    // the same one again: a reconcile, even after the PR moved on
    const again = claimVerdict(lost, 'Comment', '', pr({ head: 'head999' }), 500);

    if (!again.ok) throw new Error(again.why);
    expect(again.plan.review.reconcileOnly).toBe(true);
    expect(again.plan.review.submission).toBe(claimed.plan.review.submission);
    expect(again.plan.review.commit).toBe('head111');
    // a sure refusal of a first try lets the next one post anew
    const refused = releasedDoc(claimed.doc, claimed.plan, 'invalid', 300);

    expect(refused.submission?.attempted).toBe(false);
  });

  test('a refused plan keeps the doc with the verdict and says why', () => {
    const r = claimVerdict(doc(), 'Approve', '', pr({ head: 'head222' }), 200);

    expect(r).toMatchObject({ ok: false, tone: 'error' });
    expect(r.doc.review?.verdict).toBe('Approve');
  });

  test('a comment posted now is kept as a draft first, then claimed alone', () => {
    const target: Target = { path: 'a.ts', line: at('RIGHT', 4) };
    const kept = keepPostNow(doc(), target, ' now ', 'head111', 100);

    expect(kept?.drafts.at(-1)).toMatchObject({ seq: 3, body: 'now', head: 'head111' });
    // keeping it again adds no second draft
    expect(keepPostNow(kept ?? doc(), target, 'now', 'head111', 101)?.drafts.length).toBe(3);
    const claimed = claimPostNow(kept ?? doc(), target, 'now', 'head111', 'head111', 7, 200);

    if (!claimed.ok) throw new Error(claimed.why);
    expect(claimed.plan.seqs).toEqual([3]);
    expect(claimed.plan.said).toBe('Comment posted; pending review kept');
    const moved = claimPostNow(kept ?? doc(), target, 'now', 'head111', 'head222', 7, 200);

    expect(moved).toMatchObject({ ok: false, tone: 'error' });
    expect(!moved.ok && moved.why.endsWith('; comment kept as a draft')).toBe(true);
    // a review's saved verdict stays when the comment went
    expect(
      sentDoc({ ...claimed.doc, review: { head: 'h', verdict: 'Approve', body: '' } }, true, 300)
        .review,
    ).toBeDefined();
  });

  test('a reply is kept before it goes, refused while another is unconfirmed', () => {
    const thread = { id: 'T1', canReply: true, firstComment: 41 };
    const kept = keepReply(doc(), thread, ' sure ', 7, 100);

    if (!kept.ok) throw new Error(kept.why);
    expect(kept.reply).toMatchObject({
      thread: 'T1',
      comment_id: 41,
      body: 'sure',
      attempted: true,
    });
    expect(kept.reconcileOnly).toBe(false);
    expect(keepReply(kept.doc, { ...thread, id: 'T2' }, 'other', 7, 200)).toMatchObject({
      ok: false,
    });
    const again = keepReply(kept.doc, thread, 'sure', 7, 200);

    expect(again.ok && again.reconcileOnly).toBe(true);
    expect(replySentDoc(kept.doc, kept.reply.id, 300).reply?.confirmed).toBe(true);
    expect(replyFailedDoc(kept.doc, kept.reply.id, true, 'nope', 300).reply).toMatchObject({
      attempted: false,
      error: 'nope',
    });
    const closed = keepReply(doc(), { ...thread, canReply: false }, 'x', 7, 100);

    expect(closed.ok && closed.permitted).toBe(false);
  });
});
