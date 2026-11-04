/**
 * The review port (`ReviewPort`): the PR's checkout through git, GitHub through `gh` as the
 * person, the drafts and marks docs in the main checkout's `.scratch/abe` (1.x's files), and
 * Create Draft PR's reads and its one write. IO only; the rules are core's `review/`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  draftBody,
  Drafts,
  githubRepoOf,
  Marks,
  NO_DRAFTS,
  otherBases,
  reviewersOf,
  type DraftPrPlan,
  type ReviewAnswer,
  type ReviewErrorCode,
  type ReviewPort,
} from '@abe/core';
import { type Gh, ghRunner } from './gh';
import { type Env } from '../mac/locations';
import { reviewGit, type ReviewGit } from '../git/review-git';
import { reviewGithub, type ReviewGithub } from './review-github';
import { readJsonFile, writeJsonFile } from '../mac/state-files';

const fail = (code: ReviewErrorCode, message: string) =>
  ({ ok: false, error: { code, message } }) as const;

/** git asks `gh` for the login (never a prompt), whatever helper the person set. */
const GH_CREDENTIALS = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!gh auth git-credential',
];

/** A main checkout's review doc: `<main>/.scratch/abe/<family>/<pr>.json`. */
const docPath = (main: string, family: 'marks' | 'drafts', pr: number) =>
  join(main, '.scratch', 'abe', family, `${pr}.json`);

export const reviewPortFrom = (git: ReviewGit, github: ReviewGithub): ReviewPort => {
  const line = async (cwd: string, args: readonly string[]): Promise<ReviewAnswer<string>> => {
    const r = await git.run(cwd, args);

    return r.ok ? { ok: true, data: r.data.trim() } : r;
  };
  const repoOf = async (path: string): Promise<ReviewAnswer<string | null>> => {
    const url = await git.originUrl(path);

    return { ok: true, data: url === null ? null : (githubRepoOf(url) ?? null) };
  };
  /** Whether origin's `branch` is at `head` (asking `gh` for the login); why not known. */
  const isPublished = async (
    root: string,
    branch: string,
    head: string,
  ): Promise<ReviewAnswer<boolean>> => {
    const r = await git.run(
      root,
      [...GH_CREDENTIALS, 'ls-remote', 'origin', `refs/heads/${branch}`],
      15_000,
    );

    return r.ok
      ? { ok: true, data: r.data.split('\n').some((l) => l.split(/\s+/)[0] === head) }
      : r;
  };

  const draftPlan = async (root: string): Promise<ReviewAnswer<DraftPrPlan>> => {
    const repo = await repoOf(root);

    if (!repo.ok) return repo;
    if (repo.data === null) return fail('invalid', 'This checkout has no GitHub repository');
    const branch = await line(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

    if (!branch.ok)
      return fail('invalid', 'Create a local branch before opening a draft pull request');
    const head = await line(root, ['rev-parse', 'HEAD']);

    if (!head.ok) return head;
    const origin = (await git.originUrl(root)) ?? '';
    const base = await github.defaultBranch(repo.data);

    if (!base.ok) return base;
    const existing = await github.openPrOn(repo.data, branch.data);

    if (!existing.ok) return existing;
    const title = await line(root, ['log', '-1', '--format=%s']);
    const subjects = await git.run(root, [
      'log',
      '--reverse',
      '--format=%s',
      `origin/${base.data}..HEAD`,
    ]);
    const files = await git.run(root, ['diff', '--name-only', `origin/${base.data}...HEAD`]);
    const listed = await git.run(root, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin',
    ]);
    const others = otherBases(listed.ok ? listed.data : '', base.data, branch.data);
    const me = await github.me();
    const people = await github.people(repo.data);
    const reviewers = reviewersOf(people.ok ? people.data : [], me.ok ? me.data : null);
    const status = await git.run(root, ['status', '--porcelain']);
    const published = await isPublished(root, branch.data, head.data);

    if (!published.ok) return published;
    const subjectList = subjects.ok ? subjects.data.split('\n').filter((s) => s !== '') : [];

    return {
      ok: true,
      data: {
        root,
        repo: repo.data,
        branch: branch.data,
        head: head.data,
        base: base.data,
        origin,
        title: title.ok ? title.data : '',
        body: draftBody(branch.data, subjectList),
        commits: subjectList.length,
        files: files.ok ? files.data.split('\n').filter((l) => l !== '').length : 0,
        uncommitted: status.ok
          ? status.data
              .split('\n')
              .filter((l) => l.length > 3)
              .map((l) => l.slice(3))
          : [],
        published: published.data,
        existing: existing.data,
        branches: [base.data, ...others],
        reviewers,
      },
    };
  };

  /** The branch, its head, origin and the repo as the plan read them: else it moved meanwhile. */
  const stillPlanned = async (plan: DraftPrPlan): Promise<ReviewAnswer<null>> => {
    const branch = await line(plan.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const head = await line(plan.root, ['rev-parse', 'HEAD']);
    const origin = await git.originUrl(plan.root);
    const repo = await repoOf(plan.root);

    return branch.ok &&
      branch.data === plan.branch &&
      head.ok &&
      head.data === plan.head &&
      origin === plan.origin &&
      repo.ok &&
      repo.data === plan.repo
      ? { ok: true, data: null }
      : fail(
          'conflict',
          'The branch, revision or repository changed. Open Create Draft PR again to review its target',
        );
  };

  return {
    mainOf: git.mainOf,
    repoOf,
    changes: git.changes,
    commits: git.commits,
    packages: git.packages,
    worktrees: git.worktrees,
    checkoutPr: git.checkoutPr,
    me: github.me,
    pr: github.pr,
    prs: github.prs,
    prFiles: github.prFiles,
    threads: github.threads,
    submit: github.submit,
    postComment: github.postComment,
    reply: github.reply,
    resolve: github.resolve,
    ready: github.ready,
    close: github.close,
    say: github.say,
    draftPlan,
    draftCreate: async ({ plan, title, body, base, push }) => {
      const same = await stillPlanned(plan);

      if (!same.ok) return same;
      // another window or an earlier try may have made it already
      const open = await github.openPrOn(plan.repo, plan.branch);

      if (!open.ok) return open;
      if (open.data !== null) return { ok: true, data: open.data };
      if (title.trim() === '' || base.trim() === '' || plan.branch === base)
        return fail('invalid', 'A draft PR needs a title and a different base branch');
      const out = await isPublished(plan.root, plan.branch, plan.head);

      if (!out.ok) return out;
      if (!out.data) {
        if (!push)
          return fail(
            'refused',
            'This branch revision is not published. Choose Push branch and create draft PR to publish it explicitly',
          );
        // the commit the dialog showed, by its sha: a commit made meanwhile is not pushed
        const pushed = await git.run(
          plan.root,
          [...GH_CREDENTIALS, 'push', 'origin', `${plan.head}:refs/heads/${plan.branch}`],
          60_000,
        );

        if (!pushed.ok) return pushed;
        const again = await stillPlanned(plan);

        if (!again.ok) return again;
        const now = await isPublished(plan.root, plan.branch, plan.head);

        if (!now.ok) return now;
        if (!now.data)
          return fail(
            'conflict',
            'The remote branch moved; refresh before creating its pull request',
          );
      }
      const made = await github.createDraft({
        repo: plan.repo,
        branch: plan.branch,
        base: base.trim(),
        title: title.trim(),
        body,
      });

      if (made.ok) return made;
      // a lost answer or a creation at the same time is still found
      const found = await github.openPrOn(plan.repo, plan.branch);

      return found.ok && found.data !== null ? { ok: true, data: found.data } : made;
    },
    requestReviewers: github.requestReviewers,
    marks: (main, pr) => {
      const file = docPath(main, 'marks', pr);
      const raw = readJsonFile(file);

      if (raw === undefined && !existsSync(file)) return Promise.resolve({ ok: true, data: null });
      const m = Marks.safeParse(raw);

      return Promise.resolve(
        m.success ? { ok: true, data: m.data } : fail('failed', `marks/${pr} is not readable`),
      );
    },
    putMarks: (main, pr, marks) => {
      writeJsonFile(docPath(main, 'marks', pr), marks);

      return Promise.resolve({ ok: true, data: null });
    },
    drafts: (main, pr) => {
      const file = docPath(main, 'drafts', pr);
      const raw = readJsonFile(file);

      // a damaged doc is said so, never written over
      if (raw === undefined && !existsSync(file))
        return Promise.resolve({ ok: true, data: NO_DRAFTS });
      const d = Drafts.safeParse(raw);

      return Promise.resolve(
        d.success ? { ok: true, data: d.data } : fail('failed', `drafts/${pr} is not readable`),
      );
    },
    putDrafts: (main, pr, drafts) => {
      writeJsonFile(docPath(main, 'drafts', pr), drafts);

      return Promise.resolve({ ok: true, data: null });
    },
  };
};

/** The review port on serve's environment: git and `gh` on the person's login. */
export const reviewPort = (env: Env, gh: Gh = ghRunner(env)): ReviewPort =>
  reviewPortFrom(reviewGit(env), reviewGithub(gh));
