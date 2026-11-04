/**
 * `abe review …` and Create Draft PR (`abe pr draft-plan` / `draft-create`): VimStorm's PR review
 * in its Git Log, over the bridge. Each write runs its steps on the `ReviewPort` with the drafts
 * doc kept between them (core's `review/submit.ts`), one at a time per PR; a refusal's code says
 * its tone: `review-refused` a warning, `review-failed` an error.
 */
import {
  addDraft,
  type ChangedFile,
  chooseVerdict,
  claimPostNow,
  claimVerdict,
  type Clock,
  deleteDraft,
  type Drafts,
  draftsOf,
  dropDraft,
  editDraft,
  identityRefusal,
  type Handlers,
  keepPostNow,
  keepReply,
  marked,
  onDiff,
  type Outcome,
  readChanges,
  REJECTED,
  releasedDoc,
  replyFailedDoc,
  replySentDoc,
  REVIEW_FAILED,
  REVIEW_REFUSED,
  type ReviewAnswer,
  type ReviewPort,
  type ReviewRefusal,
  type ReviewShowData,
  type ReviewVerdict,
  refused,
  sentDoc,
  sinceReview,
  type Target,
  unconfirmed,
} from '@abe/core';
import { type SettingsService } from '../layer/settings';

export type ReviewCtx = {
  ports: { review?: ReviewPort | undefined };
  /** The Layers' settings: `githubIdentity` is the login GitHub writes go as. */
  settings?: SettingsService | undefined;
  serve: {
    clock: Clock;
  };
};

const NO_PORT = 'abe review needs this serve to reach git and GitHub (the local serve)';

/** A refusal in the status line's tone. */
const said = (r: ReviewRefusal): Outcome<never> =>
  refused(r.tone === 'error' ? REVIEW_FAILED : REVIEW_REFUSED, r.why);

const warn = (why: string) => refused(REVIEW_REFUSED, why);
const error = (why: string) => refused(REVIEW_FAILED, why);

const base = (path: string) => path.split('/').at(-1) ?? path;

/** One write per PR doc at a time: a second waits for the first to settle. */
const queues = new Map<string, Promise<unknown>>();

const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.then(work, work);
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );

  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });

  return mine;
};

const VERDICT: Readonly<Record<'approve' | 'request-changes' | 'comment', ReviewVerdict>> = {
  approve: 'Approve',
  'request-changes': 'RequestChanges',
  comment: 'Comment',
};

type Where = { port: ReviewPort; main: string; repo: string };

/** The port, the checkout's main checkout and its GitHub repo; or why not. */
const whereOf = async (ctx: ReviewCtx, path: string): Promise<Outcome<Where>> => {
  const port = ctx.ports.review;

  if (port === undefined) return refused('no-review', NO_PORT);
  const main = await port.mainOf(path);

  if (!main.ok) return refused('not-a-repo', main.error.message);
  const repo = await port.repoOf(path);

  if (!repo.ok) return refused(repo.error.code, repo.error.message);
  if (repo.data === null)
    return refused(
      'no-github-repo',
      "This project's GitHub repo is not known: open it in a GitHub checkout",
    );

  return { ok: true, data: { port, main: main.data, repo: repo.data } };
};

const withWhere = async <T>(
  ctx: ReviewCtx,
  path: string,
  then: (w: Where) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const w = await whereOf(ctx, path);

  return w.ok ? then(w.data) : w;
};

/**
 * `then`, a GitHub write, once gh's login is the `githubIdentity` in force in `path`; refused in
 * red naming both logins when it is another or cannot be read. Unset, any login goes.
 */
const asYou = async <T>(
  ctx: ReviewCtx,
  path: string,
  port: ReviewPort,
  then: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const no = await notYou(ctx, path, port);

  return no === undefined ? then() : said(no);
};

/** Why gh's login may not write as the `githubIdentity` in force in `path`; none when it may. */
const notYou = async (ctx: ReviewCtx, path: string, port: ReviewPort) => {
  const expected = ctx.settings?.at(path).values.githubIdentity ?? null;

  return expected === null ? undefined : identityRefusal(expected, await port.me());
};

/** The PR's drafts doc, read in the lock and written back by `step`. */
const withDrafts = <T>(
  w: Where,
  pr: number,
  step: (doc: Drafts, put: (d: Drafts) => Promise<ReviewAnswer<null>>) => Promise<Outcome<T>>,
): Promise<Outcome<T>> =>
  oneAtATime(`${w.main}#${pr}`, async () => {
    const doc = await w.port.drafts(w.main, pr);

    if (!doc.ok) return error(`✗ ${doc.error.message}`);

    return step(doc.data, (d) => w.port.putDrafts(w.main, pr, d));
  });

/** The PR's files as the review reads them: in the checkout, or GitHub's when not checked out. */
const filesOf = async (
  w: Where,
  pr: number,
  path: string,
  unchecked: boolean,
): Promise<ReviewAnswer<{ base: string; head: string; files: ChangedFile[] }>> => {
  const read = await w.port.pr(w.repo, pr);

  if (!read.ok) return read;
  if (!unchecked) return w.port.changes(path, `origin/${read.data.base}`);
  const files = await w.port.prFiles(w.repo, pr);

  return files.ok
    ? { ok: true, data: { base: '', head: read.data.head, files: files.data } }
    : files;
};

const show = async (
  w: Where,
  pr: number,
  path: string,
  unchecked: string | undefined,
): Promise<Outcome<ReviewShowData>> => {
  const { port, main, repo } = w;
  const [read, me, marks, drafts, threads] = await Promise.all([
    port.pr(repo, pr),
    port.me(),
    port.marks(main, pr),
    port.drafts(main, pr),
    port.threads(repo, pr),
  ]);

  if (!read.ok) return error(`✗ PR #${pr}: ${read.error.message}`);
  const checked = unchecked === undefined;
  const changes = checked
    ? await port.changes(path, `origin/${read.data.base}`)
    : await port
        .prFiles(repo, pr)
        .then((f): ReviewAnswer<{ base: string; head: string; files: ChangedFile[] }> =>
          f.ok ? { ok: true, data: { base: '', head: read.data.head, files: f.data } } : f,
        );

  if (!changes.ok) return error(`✗ PR #${pr}: ${changes.error.message}`);
  const { base: from, head, files } = changes.data;
  const [commits, packages] = checked
    ? await Promise.all([port.commits(path, from, head), port.packages(path)])
    : [undefined, undefined];
  const marked = marks.ok ? marks.data : null;
  const since = sinceReview(marked, files, head);
  const fresh = since !== null && checked ? await port.commits(path, since.from, head) : undefined;

  return {
    ok: true,
    data: {
      repo,
      number: pr,
      path,
      main,
      pr: read.data,
      me: me.ok ? me.data : null,
      unchecked: unchecked ?? null,
      read: readChanges({
        head,
        base: checked ? from : null,
        worktree: checked ? path : null,
        files,
        commits: commits?.ok === true ? commits.data : [],
        fresh: fresh?.ok === true ? fresh.data.map((c) => c.sha) : [],
        marks: marked,
        packages: packages?.ok === true ? packages.data : [],
      }),
      marks: marked,
      drafts: drafts.ok ? draftsOf(drafts.data) : { drafts: [] },
      threads: threads.ok ? threads.data : null,
      threadsError: threads.ok ? null : threads.error.message,
    },
  };
};

export const reviewHandlers = <C extends ReviewCtx>() =>
  ({
    'review show': (args, ctx) =>
      withWhere(ctx, args.path, (w) => show(w, args.pr, args.path, args.unchecked)),

    'review drafts': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const doc = await w.port.drafts(w.main, args.pr);

        return doc.ok
          ? { ok: true, data: { drafts: draftsOf(doc.data), said: '' } }
          : error(`✗ ${doc.error.message}`);
      }),

    'review mark': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        oneAtATime(`${w.main}#${args.pr}:marks`, async () => {
          const read = await filesOf(w, args.pr, args.path, args.unchecked);

          if (!read.ok) return error(`✗ PR #${args.pr}: ${read.error.message}`);
          const now = await w.port.marks(w.main, args.pr);

          if (!now.ok) return error(`✗ ${now.error.message}`);
          const next = {
            ...marked(now.data, read.data.files, args.file, !args.off, read.data.head),
            at: ctx.serve.clock.now(),
          };
          const put = await w.port.putMarks(w.main, args.pr, next);

          return put.ok ? { ok: true, data: { marks: next } } : error(`✗ ${put.error.message}`);
        }),
      ),

    'review draft': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const target: Target = {
          path: args.file,
          line: { side: args.side, line: args.line },
          ...(args.start === undefined ? {} : { start: { side: args.side, line: args.start } }),
        };
        const pr = await w.port.pr(w.repo, args.pr);

        if (!pr.ok) return error(`✗ PR #${args.pr}: ${pr.error.message}`);
        const read = await w.port.changes(args.path, `origin/${pr.data.base}`);

        if (!read.ok) return error(`✗ PR #${args.pr}: ${read.error.message}`);
        if (read.data.base !== args.base || read.data.head !== args.head)
          return warn("Comments go on the whole PR's diff: pick All changes in the Log");
        const file = read.data.files.find((f) => f.path === args.file);

        if (file === undefined) return warn(`${base(args.file)} is not in PR #${args.pr}`);
        if (!onDiff(file.patch, target))
          return warn(
            `Line ${args.line} of ${base(args.file)} is not in the PR's diff: GitHub takes comments on its lines only`,
          );
        if (args.body.trim() === '') return warn('Nothing to keep: the comment is empty');
        const keep = () =>
          withDrafts(w, args.pr, async (doc, put) => {
            const now = ctx.serve.clock.now();

            if (!args.now) {
              const drafts = draftsOf(doc);
              const added = addDraft(drafts.drafts, target, args.body, read.data.head);

              if (added === undefined) return warn('Nothing to keep: the comment is empty');
              const next: Drafts = {
                ...drafts,
                drafts: added.drafts,
                at: Math.max(drafts.at ?? 0, now) + 1,
              };
              const wrote = await put(next);

              return wrote.ok
                ? { ok: true, data: { drafts: next, said: added.said } }
                : error(`✗ ${wrote.error.message}`);
            }
            // posted now: kept as a draft on its revision first, then the PR's head read anew
            const kept = keepPostNow(doc, target, args.body, args.head, now);

            if (kept === undefined) return warn('Nothing to post: the comment is empty');
            const first = await put(kept);

            if (!first.ok) return error(`✗ ${first.error.message}`);
            const pr = await w.port.pr(w.repo, args.pr);

            if (!pr.ok) return error(`✗ PR #${args.pr}: ${pr.error.message}`);
            const claimed = claimPostNow(
              kept,
              target,
              args.body,
              args.head,
              pr.data.head,
              args.pr,
              now,
            );

            if (!claimed.ok) {
              if (claimed.doc !== undefined) await put(claimed.doc);

              return said(claimed);
            }
            const second = await put(claimed.doc);

            if (!second.ok) return error(`✗ ${second.error.message}`);
            const comment = claimed.plan.review.comments[0];

            if (comment === undefined) return error('✗ Nothing to post');
            const sent = await w.port.postComment({
              repo: w.repo,
              number: args.pr,
              head: claimed.plan.review.commit,
              submission: claimed.plan.review.submission,
              reconcileOnly: claimed.plan.review.reconcileOnly,
              comment,
            });

            return settle(claimed.doc, claimed.plan, sent, true, put, ctx.serve.clock.now());
          });

        // kept as a draft: nothing goes to GitHub yet; posted now: as githubIdentity
        return args.now ? asYou(ctx, args.path, w.port, keep) : keep();
      }),

    'review edit-draft': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        withDrafts(w, args.pr, (doc, put) =>
          rewrite(doc, put, ctx.serve.clock.now(), (all) => editDraft(all, args.seq, args.body)),
        ),
      ),

    'review drop-draft': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        withDrafts(w, args.pr, async (doc, put) => {
          if (args.seq !== undefined) {
            const seq = args.seq;

            return rewrite(doc, put, ctx.serve.clock.now(), (all) => deleteDraft(all, seq));
          }
          const file = args.file;

          if (file === undefined)
            return refused('usage', 'name the draft: --seq <n> or --file <path>', 2);
          const drafts = draftsOf(doc);
          const open = unconfirmed(drafts);

          if (
            open !== undefined &&
            drafts.drafts.some((d) => d.path === file && open.seqs.includes(d.seq))
          )
            return warn(
              'Reconcile the unconfirmed submission before dropping its original comments',
            );
          const dropped = dropDraft(drafts.drafts, file);

          if (dropped === undefined) return warn('No draft on this file to drop');
          const next: Drafts = {
            ...drafts,
            drafts: dropped.drafts,
            at: Math.max(drafts.at ?? 0, ctx.serve.clock.now()) + 1,
          };
          const wrote = await put(next);

          return wrote.ok
            ? { ok: true, data: { drafts: next, said: dropped.said } }
            : error(`✗ ${wrote.error.message}`);
        }),
      ),

    'review submit': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        asYou(ctx, args.path, w.port, () =>
          withDrafts(w, args.pr, async (doc, put) => {
            const verdict = VERDICT[args.verdict];
            const body = args.body ?? '';
            const chosen = chooseVerdict(doc, verdict, body, args.read, ctx.serve.clock.now());

            if (!chosen.ok) return said(chosen);
            const first = await put(chosen.doc);

            if (!first.ok) return error(`✗ ${first.error.message}`);
            const [pr, me] = await Promise.all([w.port.pr(w.repo, args.pr), w.port.me()]);

            if (!pr.ok) return error(`✗ PR #${args.pr}: ${pr.error.message}`);
            const claimed = claimVerdict(
              chosen.doc,
              verdict,
              body,
              {
                number: args.pr,
                head: pr.data.head,
                read: args.read,
                draft: pr.data.draft,
                own: me.ok && me.data === pr.data.author,
              },
              ctx.serve.clock.now(),
            );

            if (!claimed.ok) {
              await put(claimed.doc);

              return said(claimed);
            }
            const second = await put(claimed.doc);

            if (!second.ok) return error(`✗ ${second.error.message}`);
            const sent = await w.port.submit(w.repo, claimed.plan.review);

            return settle(claimed.doc, claimed.plan, sent, false, put, ctx.serve.clock.now());
          }),
        ),
      ),

    'review reply': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const threads = await w.port.threads(w.repo, args.pr);

        if (!threads.ok) return warn('Discussions unavailable; refresh to retry');
        const t = threads.data.find((x) => x.id === args.thread);
        const first = t?.comments[0];

        if (t === undefined || first === undefined) return warn('That discussion is not on the PR');
        if (args.body.trim() === '') return warn('Nothing to send: the reply is empty');

        return asYou(ctx, args.path, w.port, () =>
          withDrafts(w, args.pr, async (doc, put) => {
            const kept = keepReply(
              doc,
              { id: t.id, canReply: t.canReply, firstComment: first.id },
              args.body,
              args.pr,
              ctx.serve.clock.now(),
            );

            if (!kept.ok) return said(kept);
            const wrote = await put(kept.doc);

            if (!wrote.ok) return error(`✗ ${wrote.error.message}`);
            if (!kept.permitted)
              return warn('GitHub does not permit replying; reply retained in Discussions');
            const sent = await w.port.reply({
              repo: w.repo,
              number: args.pr,
              commentId: kept.reply.comment_id,
              submission: kept.reply.id,
              reconcileOnly: kept.reconcileOnly,
              body: kept.reply.body,
            });

            if (sent.ok) {
              const next = replySentDoc(kept.doc, kept.reply.id, ctx.serve.clock.now());

              await put(next);

              return { ok: true, data: { drafts: next, said: 'Reply posted' } };
            }
            const rejected =
              !kept.reconcileOnly && REJECTED.some((code) => code === sent.error.code);

            await put(
              replyFailedDoc(
                kept.doc,
                kept.reply.id,
                rejected,
                sent.error.message,
                ctx.serve.clock.now(),
              ),
            );

            return error(`${sent.error.message}; reply retained in Discussions`);
          }),
        );
      }),

    'review resolve': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const threads = await w.port.threads(w.repo, args.pr);

        if (!threads.ok) return warn('Discussions unavailable; refresh to retry');
        const t = threads.data.find((x) => x.id === args.thread);

        if (t === undefined) return warn('That discussion is not on the PR');
        if (!t.canResolve) return warn('GitHub does not permit changing this discussion');

        return asYou(ctx, args.path, w.port, async () => {
          const done = await w.port.resolve(t.id, !args.reopen);

          return done.ok
            ? {
                ok: true,
                data: { said: args.reopen ? 'Discussion reopened' : 'Discussion resolved' },
              }
            : error(`✗ ${done.error.message}`);
        });
      }),

    'review pr': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const pr = await w.port.pr(w.repo, args.pr);

        return pr.ok
          ? { ok: true, data: { pr: pr.data } }
          : refused(pr.error.code, pr.error.message);
      }),

    'review prs': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const [prs, me] = await Promise.all([w.port.prs(w.repo), w.port.me()]);

        return prs.ok
          ? { ok: true, data: { repo: w.repo, me: me.ok ? me.data : null, prs: prs.data } }
          : refused(prs.error.code, prs.error.message);
      }),

    'review open': (args, ctx) =>
      withWhere(ctx, args.path, async (w) => {
        const pr = await w.port.pr(w.repo, args.pr);

        if (!pr.ok) return error(`✗ PR #${args.pr}: ${pr.error.message}`);
        const trees = await w.port.worktrees(w.main);
        const listed = trees.ok ? trees.data : [];
        const onBranch = listed.find((t) => t.branch === pr.data.branch && t.path !== w.main);
        const own = listed.find((t) => t.branch === `pr-${args.pr}`);
        // the PR's own branch name, as gh's checkout makes it; `pr-<n>` only while the main
        // checkout itself is on that branch (git keeps a branch in one worktree)
        const inMain = listed.some((t) => t.branch === pr.data.branch && t.path === w.main);
        const fork = pr.data.fork?.split('/');
        const branch =
          onBranch !== undefined || own === undefined ? pr.data.branch : `pr-${args.pr}`;
        const local =
          inMain && onBranch === undefined && own === undefined ? `pr-${args.pr}` : branch;
        const path = onBranch?.path ?? own?.path ?? `${w.main.replace(/\/+$/, '')}-pr-${args.pr}`;
        const out = await w.port.checkoutPr({
          main: w.main,
          path,
          number: args.pr,
          branch: local,
          base: pr.data.base,
          reuse: onBranch !== undefined || own !== undefined,
          upstream: {
            ref: pr.data.branch,
            ...(fork?.length === 2 && fork[0] !== undefined && fork[1] !== undefined
              ? { fork: { owner: fork[0], repo: fork[1] } }
              : {}),
          },
        });

        return {
          ok: true,
          data: out.ok
            ? { repo: w.repo, number: args.pr, path: out.data.path, unchecked: null }
            : { repo: w.repo, number: args.pr, path: w.main, unchecked: out.error.message },
        };
      }),

    'review ready': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        asYou(ctx, args.path, w.port, async () => {
          const done = await w.port.ready(w.repo, args.pr);

          return done.ok
            ? { ok: true, data: { said: `PR #${args.pr} ready for review` } }
            : error(`✗ PR #${args.pr}: ${done.error.message}`);
        }),
      ),

    'review say': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        asYou(ctx, args.path, w.port, async () => {
          if (args.body.trim() === '') return warn('Nothing to say: the comment is empty');
          const done = await w.port.say(w.repo, args.pr, args.body);

          return done.ok
            ? { ok: true, data: { said: `Comment posted on PR #${args.pr}` } }
            : error(`✗ PR #${args.pr}: ${done.error.message}`);
        }),
      ),

    'review close': (args, ctx) =>
      withWhere(ctx, args.path, (w) =>
        asYou(ctx, args.path, w.port, async () => {
          const done = await w.port.close(w.repo, args.pr);

          return done.ok
            ? { ok: true, data: { said: `PR #${args.pr} closed without merging` } }
            : error(`✗ PR #${args.pr}: ${done.error.message}`);
        }),
      ),

    'pr draft-plan': async (args, ctx) => {
      const port = ctx.ports.review;

      if (port === undefined) return refused('no-review', NO_PORT);
      const plan = await port.draftPlan(args.path);

      return plan.ok ? plan : refused(plan.error.code, plan.error.message);
    },

    'pr draft-create': async (args, ctx) => {
      const port = ctx.ports.review;

      if (port === undefined) return refused('no-review', NO_PORT);
      const plan = await port.draftPlan(args.path);

      if (!plan.ok) return refused(plan.error.code, plan.error.message);
      if (
        plan.data.repo !== args.repo ||
        plan.data.branch !== args.branch ||
        plan.data.head !== args.head
      )
        return refused(
          'conflict',
          'The branch, revision or repository changed. Open Create Draft PR again to review its target',
        );
      const no = await notYou(ctx, args.path, port);

      if (no !== undefined) return said(no);
      const made = await port.draftCreate({
        plan: plan.data,
        title: args.title,
        body: args.body ?? '',
        base: args.base,
        push: args.push,
      });

      if (!made.ok) return refused(made.error.code, made.error.message);
      // the draft is made: a refused ask leaves it so and says why
      const asked = await port.requestReviewers(plan.data.repo, made.data.number, args.reviewer);

      return { ok: true, data: { ...made.data, asked: asked.ok ? null : asked.error.message } };
    },
  }) satisfies Partial<Handlers<C>>;

/** A drafts change the drafts allow (none while a submission is unconfirmed), written. */
const rewrite = async (
  doc: Drafts,
  put: (d: Drafts) => Promise<ReviewAnswer<null>>,
  now: number,
  change: (all: Drafts['drafts']) => { drafts: Drafts['drafts']; said: string } | undefined,
): Promise<Outcome<{ drafts: Drafts; said: string }>> => {
  const drafts = draftsOf(doc);

  if (unconfirmed(drafts) !== undefined)
    return warn('Reconcile the unconfirmed submission before changing its comments');
  const changed = change(drafts.drafts);

  if (changed === undefined) return warn('That draft is not waiting');
  const next: Drafts = { ...drafts, drafts: changed.drafts, at: Math.max(drafts.at ?? 0, now) + 1 };
  const wrote = await put(next);

  return wrote.ok
    ? { ok: true, data: { drafts: next, said: changed.said } }
    : error(`✗ ${wrote.error.message}`);
};

/** GitHub's answer to a claimed review or comment, kept: confirmed, else released with why. */
const settle = async (
  doc: Drafts,
  plan: Parameters<typeof releasedDoc>[1],
  sent: ReviewAnswer<null>,
  postNow: boolean,
  put: (d: Drafts) => Promise<ReviewAnswer<null>>,
  now: number,
): Promise<Outcome<{ drafts: Drafts; said: string }>> => {
  if (sent.ok) {
    const next = sentDoc(doc, postNow, now);

    await put(next);

    return { ok: true, data: { drafts: next, said: plan.said } };
  }
  await put(releasedDoc(doc, plan, sent.error.code, now));

  return error(`${plan.failed}: ${sent.error.message}`);
};
