/**
 * The Factory's pr stage and Done (ticket #48). `abe factory pr` from inside the run's session
 * checks the body (core's `prBodyProblems`), pushes the card's branch, and opens the pull request
 * (or updates the open one on that branch) with the card's link line; the card gets no comment
 * (`NOT_COMMENTED`).
 * From then on `serve` watches it every `every` ms: a person merges, or with `autoMerge` lowered
 * by an Override with a reason `serve` merges once its checks are green (through the port: `abe
 * pr merge` is refused inside a session); once merged, the merge commit's deployment to `test`
 * decides: success is Done, failure needs you with the deployment's link. Done runs clear after
 * the next local midnight: the session stopped, a worktree with no uncommitted or unpushed work
 * removed, one with work kept.
 */
import {
  branchKept,
  autoMergeOf,
  baseWorktreePath,
  type Clearing,
  type Clock,
  deployStateOf,
  DONE_ENVIRONMENT,
  localCheckoutOf,
  MERGED_IS_DONE,
  type ByCard,
  type Git,
  githubRepoOf,
  mergesNow,
  newlyConflicting,
  noChecksAfter,
  openedPr,
  type Outcome,
  parseRepo,
  prBodyProblems,
  prConflictPrompt,
  prNext,
  prRefusal,
  type PrData,
  type PrSeen,
  refused,
  regressionOf,
  type Run,
  type RunPr,
  sameSeen,
  seenMergeable,
  type Tracking,
  withCardLine,
  azureNamesOnThisMachine,
  isLocalBoard,
  type BoardRef,
  withClosesLine,
  withProof,
  verifyHtmlOf,
  verifyReportOf,
  withNoChecksVerified,
  withOverrideNotes,
  overrideNote,
  workKept,
  intoOf,
  withIntoLine,
  seenOf,
  reopenedSince,
  type Handlers,
} from '@abe/core';
import { readOwnBody } from '../session/own';
import { answer, type Factory, type FactoryCtx, intoBranchOn, noChecksIn, ownRun } from './factory';
import { boardKindIn, type Sessions } from '../session/sessions';
import { checkoutOf, type SettingsService } from '../layer/settings';

/** A box workspace's removal refused for now (someone still in it, Docker or Postgres down): tried again. */
const AGAIN: ReadonlySet<string> = new Set([
  'workspace-busy',
  'work-unknown',
  'docker-failed',
  'database-failed',
]);

/** `git`: each run's worktree's, by its card (on a box, its workspace's container). */
export type PrCtx = FactoryCtx & { ports: { git: ByCard<Git> | undefined } };

/**
 * Whether the run's checkout is in local mode (#24): its pull request is a local one, which a
 * person merges into the local base (never `serve`), and Done is that merge (nothing deploys it).
 */
const localIn = (settings: SettingsService | undefined, run: Run): boolean =>
  settings !== undefined &&
  localCheckoutOf(settings.at(checkoutOf(run)).values.localMode, run.repo) !== undefined;

/**
 * Whether `serve` merges the run's pull request: read in the run's checkout, never its worktree;
 * never for a run whose checks ran nothing, nor while its checkout has no check with a command
 * (#159: a run kept from before `noChecks`, or a pack removed since).
 */
const autoMergeIn = (settings: SettingsService | undefined, run: Run): boolean =>
  !run.noChecks &&
  // into a teammate's branch (`into:`): theirs to merge
  intoOf(run) === null &&
  !localIn(settings, run) &&
  settings !== undefined &&
  !noChecksIn(settings, run.repo) &&
  (run.pinned?.autoMerge ?? autoMergeOf(settings.at(checkoutOf(run))));

/**
 * What is Done for the run (#184): `factory.done` in its checkout, never its worktree: the
 * environment whose deploy of the merge commit is Done, or `merged`.
 */
const doneIn = (settings: SettingsService | undefined, run: Run): string =>
  // into a teammate's branch (`into:`): nothing deploys it, so its merge is Done
  localIn(settings, run) || intoOf(run) !== null
    ? MERGED_IS_DONE
    : (run.pinned?.done ??
      settings?.at(checkoutOf(run)).values['factory.done'] ??
      DONE_ENVIRONMENT);

/**
 * The branch pushed and its pull request opened or updated, with the card's link line; the body
 * as it was sent. Into origin's default branch, or the branch the pr step's `into:` names (a
 * teammate's pull request's head, on origin now, else refused before anything is pushed), its
 * body then opening with the fixes onto it and their pull request.
 */
const openPr = async (
  ctx: PrCtx,
  git: Git,
  run: Run,
  o: { title: string; body: string; board: Pick<BoardRef, 'provider'> },
): Promise<Outcome<{ pr: PrData; body: string }>> => {
  const branch = ctx.serve.sessions?.metaOf(run.session)?.branch;

  if (branch === undefined) return refused('no-session', `no session ${run.session}`);
  const origin = await git.origin(run.worktree);

  if (!origin.ok) return origin;
  const repo = githubRepoOf(origin.data.url);

  if (repo === undefined)
    return refused('not-github', `origin is not a repo on GitHub: ${origin.data.url}`);
  const named = intoOf(run);
  const into = named === null ? null : await intoBranchOn(git, run.worktree, named);

  if (into?.ok === false) return into;
  // their pull request, named in the body: the open one whose head is the branch
  const theirs = into === null ? null : await ctx.ports.tracking.prFind({ repo, head: into.data });
  // The repo's pre-push hook runs inside the push: its own timeout, the repo's `pr.pushTimeout`.
  const minutes = ctx.settings?.at(checkoutOf(run)).values['pr.pushTimeout'];
  const pushed = await git.push(
    run.worktree,
    branch,
    minutes === undefined ? undefined : minutes * 60_000,
  );

  if (!pushed.ok) return pushed;
  const meta = ctx.serve.sessions?.metaOf(run.session);
  // The session's Overrides go in the Notes (#114), then the line closing its spec's issues
  // (#200) and the card's link line; a run whose checks ran nothing says so first on its
  // Verified line (#159).
  const own = run.noChecks ? withNoChecksVerified(o.body) : o.body;
  const body = withCardLine(
    withClosesLine(
      withOverrideNotes(
        into === null
          ? own
          : withIntoLine(
              own,
              into.data,
              theirs?.ok === true ? (theirs.data?.number ?? null) : null,
            ),
        (meta?.overrides ?? []).map((x) => overrideNote(x, run.session)),
      ),
      run.specIssues,
      repo,
    ),
    run.card,
    o.board,
  );
  const open = await ctx.ports.tracking.prFind({ repo, head: branch });

  if (!open.ok) return open;
  const sent =
    open.data === null
      ? await ctx.ports.tracking.prCreate({
          repo,
          head: branch,
          base: into?.data ?? origin.data.defaultBranch,
          title: o.title,
          body,
          draft: false,
        })
      : await ctx.ports.tracking.prUpdate(
          { repo, number: open.data.number },
          { body, title: o.title },
        );

  return sent.ok ? { ok: true, data: { pr: sent.data, body } } : sent;
};

/**
 * The body with the Run page's Verify rows (3.0 #21): the last After report's steps, each with
 * how it was checked, its evidence and chapter, under `## Proof`, then where each feature was
 * driven (its HTML report's env, accounts and pages); as it is when none can be read.
 */
const withProofOf = async (f: Factory, run: Run, body: string): Promise<string> => {
  const after = run.verifications.findLast((v) => v.phase === 'after' && v.result === 'pass');

  if (after === undefined) return body;
  const tree = f.tree(run.card);
  const read = await tree.report(run.worktree, after.report);
  const html = after.html === undefined ? undefined : await tree.report(run.worktree, after.html);

  return read.ok
    ? withProof(body, verifyReportOf(read.data), html?.ok === true ? verifyHtmlOf(html.data) : null)
    : body;
};

/** A body file named from the workspace container, read by the run's tree inside its worktree. */
const workspaceBody = async (f: Factory, run: Run, file: string): Promise<Outcome<string>> => {
  const read = await f.tree(run.card).report(run.worktree, file);

  return read.ok
    ? read
    : refused('unreadable-body-file', `cannot read the body file ${file} in ${run.worktree}`);
};

export const prHandlers = () =>
  ({
    'factory pr': (args, ctx) =>
      ownRun(ctx, 'pr', async (f, run) => {
        // Asked before anything is pushed or opened.
        const not = prRefusal(run);

        if (not !== undefined) return refused(not.code, not.message);
        // From the workspace container (#67) the file is the container's: read there, in the worktree.
        const body =
          ctx.inside === true
            ? await workspaceBody(f, run, args.bodyFile)
            : await readOwnBody(ctx, args.bodyFile);

        if (!body.ok) return body;
        const board = boardKindIn(ctx, checkoutOf(run));
        const problems = [
          ...prBodyProblems(body.data, {
            risky: regressionOf(run).length > 0,
            regressionTests: regressionOf(run),
          }),
          // a board on this machine: GitHub would link `AB#<id>` to someone's Azure card
          ...(isLocalBoard(board) ? azureNamesOnThisMachine(args.title, body.data, run.card) : []),
        ];

        if (problems.length > 0)
          return refused('bad-pr-body', `the pull request body is refused: ${problems.join('; ')}`);
        if (ctx.ports.git === undefined)
          return refused('no-git', 'this abe serve has no git for sessions');
        const pr = await openPr(ctx, ctx.ports.git(run.card), run, {
          title: args.title,
          body: await withProofOf(f, run, body.data),
          board,
        });

        if (!pr.ok) return pr;
        // the first open's time: an update keeps it (absent on a pull request opened before)
        const openedAt = run.pr === null ? f.stamp() : run.pr.openedAt;
        const moved = await f.apply(
          run.session,
          {
            type: 'pr-opened',
            pr: {
              ...openedPr(pr.data.pr, autoMergeIn(ctx.settings, run), doneIn(ctx.settings, run)),
              reviewers: pr.data.pr.reviewers ?? run.pr?.reviewers ?? [],
              body: pr.data.body,
              ...(openedAt === undefined ? {} : { openedAt }),
            },
          },
          'pr',
        );

        return answer(f, moved);
      }),
  }) satisfies Partial<Handlers<PrCtx>>;

export type PrStageOptions = {
  factory: Factory;
  /**
   * GitHub, by the run (its checkout and card): on a box its own workspace's `gh`, so no other
   * card's container answers for its checks or merge; held where its checkout is in local mode.
   */
  tracking: (run: Run) => Tracking;
  /** Each run's worktree's git, by the run: held where its checkout is in local mode. */
  git: (run: Run) => Git;
  /**
   * On a box: a cleared run's box workspace removed (`abe workspace rm`, ADR 0022) in place of
   * its worktree, once it holds no work; refused (unpushed, someone in it), it is kept and why.
   */
  removeWorkspace?: (run: Run) => Promise<Outcome<unknown>>;
  sessions: Sessions;
  settings: SettingsService | undefined;
  clock: Clock;
  /** How often open pull requests and deploys are read and Done runs swept. */
  every: number;
  /** The first local midnight after `ms`: when a run done at `ms` clears. */
  midnightAfter: (ms: number) => number;
};

export type PrStage = {
  /** Reads each open pull request (or its merge commit's deploy) once and moves its run. */
  poll: () => Promise<void>;
  /** Clears every Done run past its next local midnight. */
  sweep: () => Promise<void>;
  stop: () => void;
};

/** `job` run once at a time: a call while it runs answers the run going on. */
const alone = (job: () => Promise<void>) => {
  let running: Promise<void> | undefined;

  return () => {
    running ??= job().finally(() => {
      running = undefined;
    });

    return running;
  };
};

/**
 * What a Done run's clearing does with its worktree (`work`: what removing it would lose, null
 * when it is gone): kept with why while it holds work past the merged head; on a box (`onBox`,
 * its whole box workspace, ADR 0022) also while its pull request is not merged; else removed.
 */
export const clearFate = (
  run: Run,
  work: { uncommitted: number; unpushed: number; head: string } | null,
  onBox: boolean,
): Omit<Clearing, 'at'> | 'remove' => {
  if (work === null) return { worktree: 'gone', why: null };
  const kept = workKept(work, run.pr?.state === 'merged' ? run.pr.headSha : undefined);

  if (kept !== null) return { worktree: 'kept', why: kept };
  if (onBox && run.pr?.state !== 'merged')
    return {
      worktree: 'kept',
      why: 'its pull request is not merged: its box workspace stays until Remove workspace…',
    };

  return 'remove';
};

export const startPrStage = (o: PrStageOptions): PrStage => {
  /** The merge commit's deploy to its Done environment (test): success moves the run to done. */
  const deploy = async (run: Run, pr: RunPr, sha: string) => {
    const repo = parseRepo(pr.repo);

    if (repo === undefined) return;
    const d = await o.tracking(run).deployStatus({ repo, sha, environment: pr.done });

    // GitHub not answering now: read again next time.
    if (!d.ok) return;
    const state = deployStateOf(d.data.state);
    const url = d.data.deployment?.url ?? null;

    if (pr.deploy?.state === state && pr.deploy.url === url) return;
    await o.factory.apply(run.session, { type: 'deployed', state, url }, 'deployed');
  };

  /** The pull request read; merged by `serve` when auto merge is on and its checks are green. */
  const show = async (run: Run, pr: RunPr) => {
    const repo = parseRepo(pr.repo);

    if (repo === undefined) return;
    const ref = { repo, number: pr.number };
    const seen = await o.tracking(run).prShow(ref);

    if (!seen.ok) return;
    let next: PrSeen = {
      title: seen.data.title,
      state: seen.data.state,
      base: seen.data.base.ref,
      mergeable: seenMergeable(pr, {
        mergeable: seen.data.mergeable,
        headSha: seen.data.head.sha,
      }),
      checks: seen.data.checks.state,
      mergeCommit: seen.data.mergeCommit,
      autoMerge: autoMergeIn(o.settings, run),
      mergeFailed: pr.mergeFailed,
      headSha: seen.data.head.sha,
      noChecksReads: noChecksAfter(pr, {
        checks: seen.data.checks.state,
        headSha: seen.data.head.sha,
      }),
      branch: pr.branch,
      done: doneIn(o.settings, run),
      // a local pull request has none to read: what the run has stays
      reviewers: seen.data.reviewers ?? pr.reviewers ?? [],
    };
    let cause = 'pr-seen';

    if (mergesNow({ ...pr, ...next }, seen.data)) {
      // The branch on origin goes with the merge only when the worktree holds nothing past the
      // head merged (work nobody pushed keeps its branch), the same check clearing makes (#48).
      const work = await o.git(run).work(run.worktree);
      const kept = branchKept(work.ok ? work.data : undefined, seen.data.head.sha);
      // Only while the head is the commit whose checks are green.
      const merged = await o.tracking(run).prMerge(ref, {
        method: 'squash',
        sha: seen.data.head.sha,
        ...(kept === null ? { deleteBranch: pr.head } : {}),
      });

      if (merged.ok && merged.data.merged) {
        const deleted = merged.data.branch;

        next = {
          ...next,
          state: 'merged',
          mergeCommit: merged.data.sha,
          mergeFailed: null,
          branch:
            deleted === undefined
              ? { deleted: false, why: kept }
              : { deleted: deleted.deleted, why: deleted.error },
        };
        cause = 'merged';
      } else
        next = {
          ...next,
          mergeFailed: merged.ok ? 'GitHub did not merge it' : merged.error.message,
        };
    }
    if (sameSeen(pr, next)) return;
    const moved = await o.factory.apply(run.session, { type: 'pr-seen', pr: next }, cause);

    // #199: a conflict is the agent's to fix, as a red check is: origin fetched first, so
    // `origin/<base>` is what GitHub merges into; told once per conflicting head.
    if (moved.ok && newlyConflicting(pr, next)) {
      const fetched = await o.git(run).fetchOrigin(run.worktree);

      await o.sessions.send(
        run.session,
        prConflictPrompt({ number: pr.number, url: pr.url, base: next.base }, fetched.ok),
      );
    }
  };

  const watched = () =>
    o.factory.all().filter((r) => r.stage === 'pr' && r.pr !== null && r.outcome === null);

  /**
   * A merged run's Done setting changed (#184: a repo with no deploy set to `merged`): kept on
   * the run, which is done at once where the merge is Done.
   */
  const redone = async (run: Run, pr: RunPr): Promise<boolean> => {
    const done = doneIn(o.settings, run);

    if (done === pr.done) return false;
    await o.factory.apply(run.session, { type: 'pr-seen', pr: { ...seenOf(pr), done } }, 'pr-seen');

    return true;
  };

  const poll = alone(async () => {
    for (const run of watched()) {
      const pr = run.pr;

      if (pr === null) continue;
      const next = prNext(pr);

      if (next === 'show') await show(run, pr);
      else if (!(await redone(run, pr)) && next === 'deploy' && pr.mergeCommit !== null)
        await deploy(run, pr, pr.mergeCommit);
    }
  });

  /**
   * A Done run cleared: its session stopped, Before's worktree removed (it never holds work), and
   * its own worktree removed unless it holds work.
   */
  const clear = async (run: Run) => {
    await o.sessions.stop(run.session);
    const work = await o.git(run).work(run.worktree);

    // Git could not say: nothing is removed, and it is tried again on the next sweep.
    if (!work.ok) return;
    const own = await removeClean(run, work.data);

    // Its box workspace could not go now (someone still in it, Docker not answering): the next
    // sweep tries again.
    if (own === undefined) return;
    const base = o.removeWorkspace === undefined ? await removeBase(run) : null;
    const at = new Date(o.clock.now()).toISOString();
    const why = [own.why, base].filter((w) => w !== null).join('; ');

    await o.factory.apply(
      run.session,
      { type: 'cleared', cleared: { at, worktree: own.worktree, why: why === '' ? null : why } },
      'cleared',
    );
  };

  /** Before's worktree at the merge base, forced: why it could not go, or null. */
  const removeBase = async (run: Run): Promise<string | null> => {
    const branch = run.pr?.head ?? o.sessions.metaOf(run.session)?.branch;

    if (branch === undefined) return null;
    const base = baseWorktreePath(run.repo, branch);
    const there = await o.git(run).work(base);

    if (!there.ok) return `Before's worktree ${base}: ${there.error.message}`;
    if (there.data === null) return null;
    const removed = await o.git(run).remove(base, { force: true });

    return removed.ok ? null : `Before's worktree ${base}: ${removed.error.message}`;
  };

  /**
   * A worktree with no work removed (git itself refuses one with changes); else kept, and why.
   * On a box its whole box workspace goes (ADR 0022), only once its pull request is merged;
   * `undefined`: it could not go now and is tried again.
   */
  const removeClean = async (
    run: Run,
    work: { uncommitted: number; unpushed: number; head: string } | null,
  ): Promise<Omit<Clearing, 'at'> | undefined> => {
    const fate = clearFate(run, work, o.removeWorkspace !== undefined);

    if (fate !== 'remove') return fate;
    if (o.removeWorkspace === undefined) {
      const removed = await o.git(run).remove(run.worktree);

      return removed.ok
        ? { worktree: 'removed', why: null }
        : { worktree: 'kept', why: removed.error.message };
    }
    const removed = await o.removeWorkspace(run);

    if (!removed.ok && AGAIN.has(removed.error.code)) return undefined;

    return removed.ok
      ? { worktree: 'removed', why: null }
      : { worktree: 'kept', why: removed.error.message };
  };

  const sweep = alone(async () => {
    const now = o.clock.now();

    for (const run of o.factory.all())
      if (
        run.outcome !== null &&
        run.cleared === null &&
        now >= o.midnightAfter(Date.parse(run.since)) &&
        // Reopened after its Done and still open (#343): its conversation and worktree stay.
        !(
          o.sessions.peek(run.session) !== 'ended' &&
          reopenedSince(o.sessions.metaOf(run.session)?.reopened ?? [], run.since)
        )
      )
        await clear(run);
  });

  // A round that fails (GitHub, git or a run's file) is tried again on the next tick.
  const timer = setInterval(() => {
    void poll()
      .then(sweep)
      .catch(() => undefined);
  }, o.every);

  return {
    poll,
    sweep,
    stop: () => {
      clearInterval(timer);
    },
  };
};
