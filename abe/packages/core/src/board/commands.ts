/**
 * The Board's rows of the command table: `abe card`, `issue`, `pr`, `deploy`, `story`, `pipeline`
 * and `fresh`.
 */
import { command } from '../command';
import {
  CardCheckoutData,
  CardCommentData,
  CardData,
  CardListData,
  CardMembersData,
  DONE_DAYS,
  cardCheckoutText,
  cardCommentText,
  cardListText,
  cardMembersText,
  cardText,
} from './board';
import { CardImagesData, cardImagesText } from './card-images';
import { FreshData, freshText } from './fresh';
import { LINKED_PARTS, StoryLinkedData, storyLinkedText } from './linked';
import { CardDraftData, cardDraftText } from './new-card';
import {
  Inspection,
  PipelineActData,
  PipelineFixData,
  PipelineListData,
  PipelineLogData,
  PipelineRun,
  PipelineRunData,
  PipelineWorkflowsData,
  pipelineActText,
  pipelineFixText,
  pipelineInspectText,
  pipelineListText,
  pipelineLogText,
  pipelineRunText,
  pipelineShowText,
  pipelineWorkflowsText,
} from './pipelines';
import {
  DeployStatusData,
  IssueData,
  MERGE_METHODS,
  MergeData,
  PrData,
  deployText,
  issueText,
  mergeText,
  prText,
} from './tracking';

const ref = (what: string) =>
  ({
    kind: 'positional',
    type: 'string',
    required: true,
    summary: `the ${what}: <owner/repo>#<n>`,
  }) as const;

const ISSUE_REF = ref('issue');

const PR_REF = ref('pull request');

export const REPO = {
  kind: 'flag',
  type: 'string',
  required: true,
  summary: '<owner/repo> on GitHub',
} as const;

const BODY_FILE = {
  kind: 'flag',
  type: 'string',
  required: true,
  summary: 'a file holding the body (markdown), relative to where abe runs',
} as const;

export const CARD_ID = {
  kind: 'positional',
  type: 'string',
  required: true,
  summary: 'the card: its id (`4`, `AB#4`)',
} as const;

const PIPELINE_RUN = {
  kind: 'positional',
  type: 'string',
  required: true,
  summary: "the run: its provider id (GitHub's run id, Azure's build id)",
} as const;

const PIPELINE_REPO = {
  kind: 'flag',
  type: 'string',
  summary: 'the checkout whose runs these are, relative to where abe runs (default: here)',
} as const;

const PIPELINE_ATTEMPT = {
  kind: 'flag',
  type: 'number',
  required: true,
  summary: 'the attempt it acts on, as inspected',
} as const;

export const BOARD_COMMANDS = {
  'issue show': command({
    noun: 'issue',
    verb: 'show',
    summary: 'an issue on GitHub with its labels, parent and sub-issues',
    inSession: true,
    inWorkspace: 'session',
    args: { ref: ISSUE_REF },
    result: IssueData,
    text: issueText,
  }),
  'issue create': command({
    noun: 'issue',
    verb: 'create',
    summary: 'open an issue on GitHub, a sub-issue of --parent when given',
    inSession: true,
    inWorkspace: 'session',
    args: {
      repo: REPO,
      title: { kind: 'flag', type: 'string', required: true, summary: 'the title' },
      bodyFile: BODY_FILE,
      label: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: 'a label to set (again for more)',
      },
      parent: {
        kind: 'flag',
        type: 'number',
        summary: 'the number of an issue in the same repo the new one becomes a sub-issue of',
      },
    },
    result: IssueData,
    text: issueText,
  }),
  'pr show': command({
    noun: 'pr',
    verb: 'show',
    summary: "a pull request: state, head, base, whether it merges, and its head's checks",
    inSession: true,
    args: { ref: PR_REF },
    result: PrData,
    text: prText,
  }),
  'pr create': command({
    noun: 'pr',
    verb: 'create',
    summary: 'open a pull request on GitHub',
    inSession: true,
    args: {
      repo: REPO,
      head: { kind: 'flag', type: 'string', required: true, summary: 'the branch to merge' },
      base: { kind: 'flag', type: 'string', required: true, summary: 'the branch to merge into' },
      title: { kind: 'flag', type: 'string', required: true, summary: 'the title' },
      bodyFile: BODY_FILE,
      draft: { kind: 'flag', type: 'boolean', summary: 'open it as a draft' },
    },
    result: PrData,
    text: prText,
  }),
  'pr update': command({
    noun: 'pr',
    verb: 'update',
    summary: "replace a pull request's body (and title)",
    inSession: true,
    args: {
      ref: PR_REF,
      bodyFile: BODY_FILE,
      title: { kind: 'flag', type: 'string', summary: 'a new title' },
    },
    result: PrData,
    text: prText,
  }),
  'pr merge': command({
    noun: 'pr',
    verb: 'merge',
    summary: 'merge a pull request (a person merges: not from inside a session)',
    inSession: false,
    risky: true,
    args: {
      ref: PR_REF,
      method: {
        kind: 'flag',
        type: 'string',
        values: MERGE_METHODS,
        summary: 'how, squash by default',
      },
      sha: {
        kind: 'flag',
        type: 'string',
        summary: 'merge only while the head is still this commit',
      },
    },
    result: MergeData,
    text: mergeText,
  }),
  'deploy status': command({
    noun: 'deploy',
    verb: 'status',
    summary: "a commit's newest deployment to an environment and its latest status",
    inSession: true,
    args: {
      repo: REPO,
      sha: { kind: 'flag', type: 'string', required: true, summary: 'the commit' },
      env: { kind: 'flag', type: 'string', required: true, summary: 'the environment' },
    },
    result: DeployStatusData,
    text: deployText,
  }),
  'card list': command({
    noun: 'card',
    verb: 'list',
    summary: "the board's open cards, newest change first (the board from the settings)",
    inSession: true,
    args: {
      mine: { kind: 'flag', type: 'boolean', summary: 'only the cards assigned to you' },
      closed: {
        kind: 'flag',
        type: 'boolean',
        summary: `the done ones too: the current sprint's, else the last ${DONE_DAYS} days'`,
      },
    },
    result: CardListData,
    text: cardListText,
  }),
  'card images': command({
    noun: 'card',
    verb: 'images',
    summary:
      "read a card's images into local files (the story dialog's): only attachments of the board's own Azure DevOps organization",
    inSession: false,
    args: {
      url: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: "an image's address in the card's text or comments",
      },
    },
    result: CardImagesData,
    text: cardImagesText,
  }),
  'card comment': command({
    noun: 'card',
    verb: 'comment',
    summary: 'add a comment (markdown) to a card: --text or --body-file, one of them',
    inSession: true,
    inWorkspace: 'session',
    args: {
      id: CARD_ID,
      text: { kind: 'flag', type: 'string', summary: 'the comment (markdown), in place of a file' },
      bodyFile: { ...BODY_FILE, required: false },
    },
    result: CardCommentData,
    text: cardCommentText,
  }),
  'card tag': command({
    noun: 'card',
    verb: 'tag',
    summary: "add tags to a card or take them off; a tag's case does not matter",
    inSession: true,
    args: {
      id: CARD_ID,
      add: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: 'a tag to add (again for more)',
      },
      remove: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: 'a tag to take off (again for more)',
      },
    },
    result: CardData,
    text: cardText,
  }),
  'card move': command({
    noun: 'card',
    verb: 'move',
    summary: "set a card's state (one its type has: New, Active, Resolved …)",
    inSession: true,
    args: {
      id: CARD_ID,
      state: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the state, quoted or as words (`Ready for test`)',
      },
    },
    result: CardData,
    text: cardText,
  }),
  'card assign': command({
    noun: 'card',
    verb: 'assign',
    summary:
      'assign a card to you, a teammate or no one (a person assigns: not from inside a session)',
    inSession: false,
    args: {
      id: CARD_ID,
      who: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          "me, none, or a teammate on the board's team: their email, name or email before the @ (`abe card members`)",
      },
    },
    result: CardData,
    text: cardText,
  }),
  'card members': command({
    noun: 'card',
    verb: 'members',
    summary: "the board's team members a card can be assigned to: you first, then by name",
    inSession: true,
    args: {},
    result: CardMembersData,
    text: cardMembersText,
  }),
  'card checkout': command({
    noun: 'card',
    verb: 'checkout',
    summary:
      "a worktree on this machine on the card's branch as origin has it (a teammate's story, or one on a box): fetched, beside the checkout; reads only",
    inSession: false,
    args: {
      id: CARD_ID,
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          "this machine's checkout of the card's repo, relative to where abe runs (default: here)",
      },
    },
    result: CardCheckoutData,
    text: cardCheckoutText,
  }),
  'card create': command({
    noun: 'card',
    verb: 'create',
    summary:
      "a new card on the board: of its first type, in New, unassigned, in the team's current sprint unless told otherwise (from inside a session only a ticket: a child of its own card)",
    inSession: true,
    inWorkspace: 'session',
    args: {
      title: { kind: 'flag', type: 'string', required: true, summary: 'its title' },
      parent: {
        kind: 'flag',
        type: 'string',
        summary: 'the card it is a child of (`4`, `AB#4`): a ticket of that card',
      },
      type: {
        kind: 'flag',
        type: 'string',
        summary: "one of the board's types (default: its first)",
      },
      state: {
        kind: 'flag',
        type: 'string',
        summary: "its column: a state its type has (default: the type's first, New)",
      },
      assign: {
        kind: 'flag',
        type: 'string',
        values: ['me', 'none'],
        summary: 'me: assigned to you; none (default): nobody',
      },
      sprint: {
        kind: 'flag',
        type: 'string',
        values: ['current', 'none'],
        summary: "current (default): the team's current sprint; none: the backlog",
      },
      description: {
        kind: 'flag',
        type: 'string',
        summary: 'its description (markdown), in place of a file',
      },
      descriptionFile: {
        kind: 'flag',
        type: 'string',
        summary: 'a file holding its description (markdown)',
      },
      criteria: {
        kind: 'flag',
        type: 'string',
        summary: 'its acceptance criteria (markdown), in place of a file',
      },
      criteriaFile: {
        kind: 'flag',
        type: 'string',
        summary: 'a file holding its acceptance criteria (markdown)',
      },
    },
    result: CardData,
    text: cardText,
  }),
  'card draft': command({
    noun: 'card',
    verb: 'draft',
    summary:
      "a new card's Why, What and acceptance criteria drafted by a one-shot from your words (make-card's card part); nothing is written",
    inSession: false,
    args: {
      words: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the title, or what the card is about, in your words',
      },
      session: {
        kind: 'flag',
        type: 'string',
        summary: 'the Ask chat it comes from: its conversation read in',
      },
      earlier: {
        kind: 'flag',
        type: 'string',
        summary: 'the earlier draft as JSON (abe card draft --json): drafted again from it',
      },
    },
    result: CardDraftData,
    text: cardDraftText,
  }),
  'story linked': command({
    noun: 'story',
    verb: 'linked',
    summary:
      'Linked: everything on a story in nine rows (story, prototype, spec, sessions, pull request, pipelines, worktree, box, Sheets), each with its state; a part that could not be read says why on its row (Run is on the stripe)',
    inSession: false,
    args: {
      id: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the story: its id (`2`, `AB#2`)',
      },
      part: {
        kind: 'flag',
        type: 'string',
        values: LINKED_PARTS,
        summary:
          'read only this part (the popup reads each on its own): card, run, spec, pr, pipelines, box; the other rows say Reading…',
      },
    },
    result: StoryLinkedData,
    text: storyLinkedText,
  }),
  'pipeline list': command({
    noun: 'pipeline',
    verb: 'list',
    summary:
      "the repo's latest pipeline runs, newest first: GitHub Actions, or Azure Pipelines as the pipelines setting says",
    inSession: true,
    args: {
      repo: PIPELINE_REPO,
      limit: { kind: 'flag', type: 'number', summary: 'how many runs (default 30, at most 100)' },
      workflow: {
        kind: 'flag',
        type: 'string',
        summary: "one workflow's runs: its name or file (Azure: the pipeline's name)",
      },
      page: {
        kind: 'flag',
        type: 'number',
        summary: 'a later page of `--limit` runs (the first is 1)',
      },
    },
    result: PipelineListData,
    text: pipelineListText,
    waits: 'the pipelines',
  }),
  'pipeline workflows': command({
    noun: 'pipeline',
    verb: 'workflows',
    summary:
      'the workflows a person may run by hand (`on: workflow_dispatch`) and the inputs each takes, read at a ref; GitHub Actions only for now',
    inSession: true,
    args: {
      ref: {
        kind: 'flag',
        type: 'string',
        summary:
          "the branch or tag their files are read at (default: the repository's default branch)",
      },
      repo: PIPELINE_REPO,
    },
    result: PipelineWorkflowsData,
    text: pipelineWorkflowsText,
    waits: 'the pipelines',
  }),
  'pipeline run': command({
    noun: 'pipeline',
    verb: 'run',
    summary:
      'run a workflow by hand on a ref with its inputs, as you (`gh workflow run`), and name its run once it is listed; GitHub Actions only for now',
    inSession: false,
    args: {
      workflow: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the workflow: its file (`deploy.yml`) or name',
      },
      ref: {
        kind: 'flag',
        type: 'string',
        summary: "the branch or tag it runs on (default: the checkout's branch)",
      },
      input: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: 'an input, `name=value` (given again for more); never a secret',
      },
      repo: PIPELINE_REPO,
    },
    result: PipelineRunData,
    text: pipelineRunText,
    waits: 'the pipelines',
  }),
  'pipeline show': command({
    noun: 'pipeline',
    verb: 'show',
    summary: 'one run read in full: its stages and the approval gates the waiting ones stand at',
    inSession: true,
    args: { run: PIPELINE_RUN, repo: PIPELINE_REPO },
    result: PipelineRun,
    text: pipelineShowText,
    waits: 'the pipelines',
  }),
  'pipeline inspect': command({
    noun: 'pipeline',
    verb: 'inspect',
    summary:
      "a run's attempt: its jobs with their steps, the dependency graph from the run's own revision, its artifacts",
    inSession: true,
    args: {
      run: PIPELINE_RUN,
      repo: PIPELINE_REPO,
      attempt: {
        kind: 'flag',
        type: 'number',
        summary: 'an earlier attempt (default: the latest)',
      },
    },
    result: Inspection,
    text: pipelineInspectText,
    waits: 'the pipelines',
  }),
  'pipeline log': command({
    noun: 'pipeline',
    verb: 'log',
    summary: "a job's whole log, as the provider keeps it",
    inSession: true,
    args: {
      run: PIPELINE_RUN,
      job: { kind: 'flag', type: 'string', required: true, summary: 'the job: its id' },
      repo: PIPELINE_REPO,
    },
    result: PipelineLogData,
    text: pipelineLogText,
    waits: 'the pipelines',
  }),
  'pipeline rerun': command({
    noun: 'pipeline',
    verb: 'rerun',
    summary:
      'run a run again (--failed: its failed jobs and those they skipped), on the attempt named: one that changed or still runs is refused',
    inSession: false,
    args: {
      run: PIPELINE_RUN,
      attempt: PIPELINE_ATTEMPT,
      failed: { kind: 'flag', type: 'boolean', summary: 'only the failed jobs' },
      repo: PIPELINE_REPO,
    },
    result: PipelineActData,
    text: pipelineActText,
    waits: 'the pipelines',
  }),
  'pipeline cancel': command({
    noun: 'pipeline',
    verb: 'cancel',
    summary: 'cancel a running run (its attempt named: one that changed is refused)',
    inSession: false,
    risky: true,
    args: { run: PIPELINE_RUN, attempt: PIPELINE_ATTEMPT, repo: PIPELINE_REPO },
    result: PipelineActData,
    text: pipelineActText,
    waits: 'the pipelines',
  }),
  'pipeline approve': command({
    noun: 'pipeline',
    verb: 'approve',
    summary:
      "approve a waiting run's deployment to an environment, as you; a prod environment's only with --yes",
    inSession: false,
    risky: true,
    args: {
      run: PIPELINE_RUN,
      environment: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the environment its gate guards (Azure: the stage)',
      },
      yes: {
        kind: 'flag',
        type: 'boolean',
        summary: 'yes, deploy to prod: needed for a prod environment (prodEnvironments)',
      },
      repo: PIPELINE_REPO,
    },
    result: PipelineActData,
    text: pipelineActText,
    waits: 'the pipelines',
  }),
  'pipeline fix': command({
    noun: 'pipeline',
    verb: 'fix',
    summary:
      "Fix with agent: a failed run to a Claude Code session in your Local sandbox, on the card's branch or a fix branch from the failed revision; a card's live session gets it as a message",
    inSession: false,
    args: {
      run: PIPELINE_RUN,
      card: {
        kind: 'flag',
        type: 'string',
        summary:
          'the card the fix is for (default: the card whose card/<n>-… branch the run is on)',
      },
      job: {
        kind: 'flag',
        type: 'string',
        summary: 'the failed job it covers (default: every failed one)',
      },
      evidence: {
        kind: 'flag',
        type: 'string',
        summary: 'a log line it goes with (`log line 412 · …`)',
      },
      artifact: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          "an artifact it goes with: its id (an expired one or another revision's is left out)",
      },
      message: {
        kind: 'flag',
        type: 'string',
        summary: 'what the agent should do (default: composed)',
      },
      repo: PIPELINE_REPO,
    },
    result: PipelineFixData,
    text: pipelineFixText,
    waits: 'the pipelines',
  }),
  fresh: command({
    noun: 'fresh',
    summary:
      "look now for what changed outside Abe here (#236): the board's cards on Azure DevOps, the repo's pull requests on GitHub, the runs of the pipelines in force; each change is a board.changed, github.changed or pipelines.changed event",
    inSession: false,
    // the Factory view's own (its focus, its open); `--follow` streams
    only: 'client',
    args: {
      follow: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'stay: look at once, then every 2 min until Ctrl-C (what a shown view holds), printing each change as `abe watch` does',
      },
    },
    result: FreshData,
    text: freshText,
  }),
};
