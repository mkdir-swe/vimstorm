/** PR review's rows of the command table: `abe review` and Create Draft PR's `pr draft-…`. */
import { command } from '../command';
import {
  DraftPrMadeData,
  DraftPrPlanData,
  ReviewDraftsData,
  ReviewMarksData,
  ReviewOpenData,
  ReviewPrData,
  ReviewPrsData,
  ReviewSaidData,
  ReviewShowData,
  draftPrMadeText,
  draftPrPlanText,
  reviewMarksText,
  reviewOpenText,
  reviewPrText,
  reviewPrsText,
  reviewShowText,
} from './contract';

// ---- PR review in VimStorm's Git Log (the shell's own: not in Command mode) ----

const REVIEW_PR = {
  kind: 'positional',
  type: 'number',
  required: true,
  summary: 'the pull request number',
} as const;

const REVIEW_PATH = {
  kind: 'flag',
  type: 'string',
  required: true,
  summary: 'the checkout the PR is reviewed in',
} as const;

const REVIEW_FILE = {
  kind: 'flag',
  type: 'string',
  required: true,
  summary: "a file's path in the PR's diff",
} as const;

const REVIEW_SIDE = {
  kind: 'flag',
  type: 'string',
  values: ['LEFT', 'RIGHT'],
  required: true,
  summary: "the diff's side: LEFT the base, RIGHT the head",
} as const;

const REVIEW_LINE = {
  kind: 'flag',
  type: 'number',
  required: true,
  summary: 'the line, on its side',
} as const;

const REVIEW_START = {
  kind: 'flag',
  type: 'number',
  summary: 'the first line of a range, on the same side',
} as const;

const REVIEW_BODY = {
  kind: 'flag',
  type: 'string',
  required: true,
  verbatim: true,
  summary: 'the text (markdown)',
} as const;

const REVIEW_SHA = (what: string) =>
  ({ kind: 'flag', type: 'string', required: true, summary: what }) as const;

export const REVIEW_COMMANDS = {
  'review show': command({
    noun: 'review',
    verb: 'show',
    summary:
      'a PR under review: its files against the merge base, commits, marks, drafts and discussions',
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      unchecked: {
        kind: 'flag',
        type: 'string',
        summary: 'why it is not checked out: its files come from GitHub',
      },
    },
    result: ReviewShowData,
    text: reviewShowText,
  }),
  'review pr': command({
    noun: 'review',
    verb: 'pr',
    summary: 'a PR under review as GitHub has it now, in one read: what the review polls',
    inSession: false,
    only: 'shell',
    args: { pr: REVIEW_PR, path: REVIEW_PATH },
    result: ReviewPrData,
    text: reviewPrText,
  }),
  'review drafts': command({
    noun: 'review',
    verb: 'drafts',
    summary: "a PR's review drafts as kept",
    inSession: false,
    only: 'shell',
    args: { pr: REVIEW_PR, path: REVIEW_PATH },
    result: ReviewDraftsData,
    says: 'said',
  }),
  'review mark': command({
    noun: 'review',
    verb: 'mark',
    summary: 'mark files of a PR reviewed (or back to review) as they are now',
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      file: { ...REVIEW_FILE, repeats: true },
      off: { kind: 'flag', type: 'boolean', summary: 'back to review' },
      unchecked: {
        kind: 'flag',
        type: 'boolean',
        summary: 'not checked out: its files from GitHub',
      },
    },
    result: ReviewMarksData,
    text: reviewMarksText,
  }),
  'review draft': command({
    noun: 'review',
    verb: 'draft',
    summary:
      "keep a review comment on a line of the PR's diff as a draft (with --now: post it now)",
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      file: REVIEW_FILE,
      side: REVIEW_SIDE,
      line: REVIEW_LINE,
      start: REVIEW_START,
      body: REVIEW_BODY,
      base: REVIEW_SHA("the diff's base commit"),
      head: REVIEW_SHA("the diff's head commit"),
      now: { kind: 'flag', type: 'boolean', summary: 'post it now, on its own' },
    },
    result: ReviewDraftsData,
    says: 'said',
  }),
  'review edit-draft': command({
    noun: 'review',
    verb: 'edit-draft',
    summary: "replace a waiting draft's text, its line kept",
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      seq: { kind: 'flag', type: 'number', required: true, summary: "the draft's number" },
      body: REVIEW_BODY,
    },
    result: ReviewDraftsData,
    says: 'said',
  }),
  'review drop-draft': command({
    noun: 'review',
    verb: 'drop-draft',
    summary: "drop a waiting draft: by its number, else a file's latest",
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      seq: { kind: 'flag', type: 'number', summary: "the draft's number" },
      file: { ...REVIEW_FILE, required: false },
    },
    result: ReviewDraftsData,
    says: 'said',
  }),
  'review submit': command({
    noun: 'review',
    verb: 'submit',
    summary: 'send one review with the drafts on the head read; refused when the PR moved since',
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      verdict: {
        kind: 'flag',
        type: 'string',
        values: ['approve', 'request-changes', 'comment'],
        required: true,
        summary: 'the verdict',
      },
      body: { ...REVIEW_BODY, required: false },
      read: REVIEW_SHA('the head the changes were read at'),
    },
    result: ReviewDraftsData,
    says: 'said',
  }),
  'review reply': command({
    noun: 'review',
    verb: 'reply',
    summary: 'reply to a posted discussion of the PR',
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      thread: { kind: 'flag', type: 'string', required: true, summary: "the discussion's id" },
      body: REVIEW_BODY,
    },
    result: ReviewDraftsData,
    says: 'said',
  }),
  'review resolve': command({
    noun: 'review',
    verb: 'resolve',
    summary: 'resolve (or reopen) a posted discussion of the PR',
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      thread: { kind: 'flag', type: 'string', required: true, summary: "the discussion's id" },
      reopen: { kind: 'flag', type: 'boolean', summary: 'reopen it' },
    },
    result: ReviewSaidData,
    says: 'said',
  }),
  'review prs': command({
    noun: 'review',
    verb: 'prs',
    summary: "a checkout's repo's open pull requests, as the Git Log's PR pick lists them",
    inSession: false,
    only: 'shell',
    args: { path: REVIEW_PATH },
    result: ReviewPrsData,
    text: reviewPrsText,
  }),
  'review open': command({
    noun: 'review',
    verb: 'open',
    summary:
      'check a PR out to review it: the worktree on its branch, else its own `<repo>-pr-<n>`',
    inSession: false,
    only: 'shell',
    args: { pr: REVIEW_PR, path: REVIEW_PATH },
    result: ReviewOpenData,
    text: reviewOpenText,
  }),
  'review ready': command({
    noun: 'review',
    verb: 'ready',
    summary: 'mark a draft pull request ready for review',
    inSession: false,
    only: 'shell',
    args: { pr: REVIEW_PR, path: REVIEW_PATH },
    result: ReviewSaidData,
    says: 'said',
  }),
  'review say': command({
    noun: 'review',
    verb: 'say',
    summary: "a comment on a pull request's conversation (not on a line, not in a review)",
    inSession: false,
    only: 'shell',
    args: {
      pr: REVIEW_PR,
      path: REVIEW_PATH,
      body: {
        kind: 'flag',
        type: 'string',
        required: true,
        verbatim: true,
        summary: 'the text (markdown)',
      },
    },
    result: ReviewSaidData,
    says: 'said',
  }),
  'review close': command({
    noun: 'review',
    verb: 'close',
    summary: 'close a pull request without merging it (its branch stays)',
    inSession: false,
    only: 'shell',
    risky: true,
    args: { pr: REVIEW_PR, path: REVIEW_PATH },
    result: ReviewSaidData,
    says: 'said',
  }),
  'pr draft-plan': command({
    noun: 'pr',
    verb: 'draft-plan',
    summary:
      'what Create Draft PR starts from: the branch, its base, title, description and reviewers',
    inSession: false,
    only: 'shell',
    args: { path: REVIEW_PATH },
    result: DraftPrPlanData,
    text: draftPrPlanText,
  }),
  'pr draft-create': command({
    noun: 'pr',
    verb: 'draft-create',
    summary: "open the checkout's branch as a draft pull request (an open one on it is reused)",
    inSession: false,
    only: 'shell',
    args: {
      path: REVIEW_PATH,
      repo: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the repository the plan read (owner/name): refused when origin names another',
      },
      branch: REVIEW_SHA('the branch the plan read'),
      head: REVIEW_SHA('the head the plan read: refused when it moved'),
      base: REVIEW_SHA('the branch to merge into'),
      title: { kind: 'flag', type: 'string', required: true, summary: 'the title' },
      body: { ...REVIEW_BODY, required: false },
      push: { kind: 'flag', type: 'boolean', summary: 'push the branch first when it is not' },
      reviewer: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: 'a login asked to review it',
      },
    },
    result: DraftPrMadeData,
    text: draftPrMadeText,
  }),
};
