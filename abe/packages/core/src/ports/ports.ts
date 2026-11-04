/** The interfaces `ports` implements and `testing` fakes. Core never reaches the world itself. */
import {
  type BoardChanges,
  type AssignTo,
  type BoardMember,
  type BoardRef,
  type Boarded,
  type CardCommentData,
  type CardData,
  type CardDetail,
  type DoneCards,
  type Person,
  type Sprint,
} from '../board/board';
import { type SignIns, type StorageState } from '../browser/browser-state';
import {
  type CiWorkflowFile,
  type DispatchWorkflow,
  type Gate,
  type Inspection,
  type PipelineRun,
} from '../board/pipelines';
import { type BaseDiff } from '../factory/checks';
import { type MadeCommit } from '../factory/step-made';
import { type HostLoad } from '../box/box-load';
import { type AwsAccount, type McpState } from '../install/install-connection';
import { type CheckRun } from '../install/install-kind';
import { type SourceProbe } from '../install/install-source-account';
import { type SignInResult } from '../install/source-sign-in';
import { type FoundServer, type SourceEntry, type SourceServers } from '../install/source-servers';
import { type LocalPrChanges } from '../local-mode/local-mode';
import { type LoginCheck, type LoginTool } from '../logins/logins';
import { type LogSources, type LogsRead } from '../improve/logs';
import { type RefusedRequest, type StartRun } from '../prototype/prototype';
import { type BranchBase, type ClaudeSettings } from '../session/session';
import { type SessionMcp } from '../layer/settings';
import { type SetupRan, type WorktreeCopy } from '../session/setup';
import { type PluginFile } from '../skills/subagents';
import { type RepoHooks } from '../repo-hooks';
import { type FoundManager } from '../install/serve-path';
import { type ToolRan } from '../install/tools';
import {
  type DeployStatusData,
  type IssueCommentData,
  type IssueData,
  type MergeData,
  type MergeMethod,
  type OpenIssue,
  type PrData,
  type PrReview,
  type PrTouch,
  type Ref,
  type Repo,
  type Tracked,
} from '../board/tracking';
import { type WORKSPACE_APPARMOR, type WORKSPACE_SYSTEM_PATHS } from '../box/workspace';
import { type ChangedFile, type Changes, type RangeCommit } from '../review/changes';
import { type OpenPr, type ReviewPr, type Thread } from '../review/contract';
import { type Drafts, type ReviewComment, type ReviewOut } from '../review/drafts';
import { type Marks } from '../review/marks';
import { type DemoCard, type DemoIssue } from '../demo/demo';

/** Wall-clock time in epoch milliseconds. */
export type Clock = { now: () => number };

/**
 * Tracking on GitHub (ADR 0009), as the person: `gh` on its own keyring login. Every call answers
 * its data or a `TrackingError`; none throws for a refusal of GitHub's.
 */
export type Tracking = {
  issueShow: (ref: Ref) => Promise<Tracked<IssueData>>;
  /** `parent`: an issue of the same repo the new one becomes a sub-issue of; checked before it is opened. */
  issueCreate: (input: {
    repo: Repo;
    title: string;
    body: string;
    labels: readonly string[];
    parent?: number;
  }) => Promise<Tracked<IssueData>>;
  /** Markdown as a new comment on an issue or pull request. */
  issueComment: (ref: Ref, body: string) => Promise<Tracked<IssueCommentData>>;
  prShow: (ref: Ref) => Promise<Tracked<PrData>>;
  /** The open pull request whose head is `head` (a branch of `repo`), or null for none. */
  prFind: (input: { repo: Repo; head: string }) => Promise<Tracked<PrData | null>>;
  prCreate: (input: {
    repo: Repo;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }) => Promise<Tracked<PrData>>;
  prUpdate: (ref: Ref, change: { body: string; title?: string }) => Promise<Tracked<PrData>>;
  /**
   * `sha`: merge only while the head is still this commit. `deleteBranch`: the head branch, deleted
   * on GitHub once merged (gone already counts as deleted); a failed delete leaves the merge done.
   */
  prMerge: (
    ref: Ref,
    how: { method: MergeMethod; sha?: string; deleteBranch?: string },
  ) => Promise<Tracked<MergeData>>;
  deployStatus: (input: {
    repo: Repo;
    sha: string;
    environment: string;
  }) => Promise<Tracked<DeployStatusData>>;
  /** A pull request's submitted reviews (pending ones left out), oldest first. */
  prReviews: (ref: Ref) => Promise<Tracked<PrReview[]>>;
  /** The person `gh` is logged in as: their GitHub login. */
  me: () => Promise<Tracked<{ login: string }>>;
  /**
   * The repo's pull requests in any state, the last changed first, at most `FRESH_PAGE` (#236):
   * a review, a push, a merge or a comment changes one.
   */
  recentPrs: (repo: Repo) => Promise<Tracked<PrTouch[]>>;
  /** The repo's open issues (pull requests left out), newest first, at most 100. */
  issueList: (repo: Repo) => Promise<Tracked<OpenIssue[]>>;
};

/**
 * A session's worktree through `git` (`ports/src/git/git.ts`): what the pr stage pushes and what
 * clearing a Done card removes. Every call answers or says why not; none throws.
 */
export type Git = {
  /** `origin`'s URL as the config writes it (not rewritten by `insteadOf`) and its default branch. */
  origin: (worktree: string) => Promise<Answered<{ url: string; defaultBranch: string }>>;
  /**
   * `branch` pushed to `origin`, its upstream set; stopped after `timeoutMs` (the repo's
   * `pr.pushTimeout`: its pre-push hook runs inside the push), `push-timeout` then.
   */
  push: (worktree: string, branch: string, timeoutMs?: number) => Promise<Answered<null>>;
  /** `origin` fetched, so its branches (`origin/main`) are as GitHub has them now (#199). */
  fetchOrigin: (worktree: string) => Promise<Answered<null>>;
  /** Whether origin has `branch` now (`git ls-remote --heads`): a pr step's `into:`. */
  onOrigin: (worktree: string, branch: string) => Promise<Answered<boolean>>;
  /**
   * The worktree's branch started at origin's `from`, fetched now (a pr step's `into:`, a
   * teammate's pull request's head): moved there while it holds no work of its own (no changed
   * tracked file, no commit origin's `base` lacks; else `own-work`); as it is when it holds `from`
   * already (`moved: false`). Nothing is pushed: origin's `from` is never written.
   */
  startAt: (
    worktree: string,
    o: { from: string; base: string },
  ) => Promise<Answered<{ moved: boolean }>>;
  /**
   * What removing it would lose: changed or untracked files (ignored ones are not work) and
   * commits on no remote branch, with its head commit; null when the worktree is gone.
   */
  work: (
    worktree: string,
  ) => Promise<Answered<{ uncommitted: number; unpushed: number; head: string } | null>>;
  /**
   * Removes the worktree (git itself refuses one with changes, unless `force`: Before's at the
   * merge base, which never holds work); its branch stays.
   */
  remove: (worktree: string, o?: { force: boolean }) => Promise<Answered<null>>;
  /**
   * The card's writer subagents tidied (#183), as `serve`'s own git outside the sandbox (whose
   * `.git` the session cannot write): each writer worktree whose head the card branch holds
   * removed (git refuses one with changes): any under `<worktree>/.claude/worktrees`, and under
   * `<repo>/.claude/worktrees`, where Claude Code puts them beside other sessions' (#218), only
   * those of `agents`; the record of one gone from disk removed once the card branch holds its
   * branch (kept till then, so a later tidy still finds the branch: never a `git worktree prune`),
   * the stale records of every other worktree gone from disk pruned (never a writer's, anyone's,
   * nor a locked one), and each `worktree-agent-*` branch of theirs (or of `agents`, Claude Code's
   * agent ids) the card branch holds and no worktree has deleted. Never one not merged,
   * never another worktree there. `branch` is the card's; once `worktree` is gone, from `repo`.
   */
  tidyWriters: (o: {
    worktree: string;
    repo: string;
    branch: string;
    agents: readonly string[];
  }) => Promise<Answered<{ removed: string[]; deleted: string[] }>>;
};

/**
 * A card's branch as origin has it, checked out on this Mac (`ports/src/git/worktrees.ts`): origin
 * fetched, its `card/<card>` or `card/<card>-*` branch (the newest commit when there are more), a
 * worktree on it beside the main checkout tracking it, or the one it is checked out in already.
 * None on origin: refused `no-branch`.
 */
export type CardCheckout = (
  repo: string,
  card: string,
) => Promise<Answered<{ path: string; branch: string; made: boolean }>>;

/**
 * Local mode's pull requests (#24), on this Mac only: a branch's head commit, and a squash merge
 * of `head` into the local `base` (its working tree moved along where `base` is checked out and
 * clean). Nothing is pushed or fetched.
 */
export type LocalMerge = {
  head: (checkout: string, branch: string) => Promise<Answered<string>>;
  squash: (
    checkout: string,
    o: { head: string; base: string; message: string },
  ) => Promise<Answered<{ sha: string }>>;
  /**
   * What `head` changes since it left `base` (their merge base): the files, base to head, with
   * lines added and removed, and its commits, oldest first.
   */
  changes: (
    checkout: string,
    o: { head: string; base: string },
  ) => Promise<Answered<LocalPrChanges>>;
};

/**
 * Where a repo's runs live (the `pipelines` setting): its GitHub repo's Actions, or an Azure
 * DevOps project's pipelines (the `board` setting's organization and project).
 */
export type PipelineSource =
  | { provider: 'github-actions'; repo: string }
  | { provider: 'azure-pipelines'; organization: string; project: string };

/** A write on a run: rerun its failed jobs, rerun it, cancel it. */
export type RunControl = 'rerun' | 'rerun-failed' | 'cancel';

/** Which runs: one workflow's (its name or file; Azure: the pipeline's name), a later page. */
export type RunQuery = { workflow?: string | undefined; page?: number | undefined };

/**
 * The runs of GitHub Actions (`gh`, as the person) or Azure Pipelines (REST on `az`'s token), each
 * in core's one shape. A write reads the run again first and never repeats one whose outcome was
 * uncertain: `attempt-changed`, `still-running`, `uncertain` say why it was not (re)sent.
 */
export type Pipelines = {
  /**
   * The latest runs of every pipeline (on `branch` only, where named; one workflow's, a later page
   * of `limit` as `query` says), newest first, stages unread.
   */
  runs: (
    source: PipelineSource,
    limit: number,
    branch?: string,
    query?: RunQuery,
  ) => Promise<Answered<PipelineRun[]>>;
  /** Every workflow's name (GitHub's catalog; Azure answers none). */
  workflows: (source: PipelineSource) => Promise<Answered<string[]>>;
  /**
   * Every workflow with its file's text on the default branch, GitHub's active ones (kept a few
   * minutes, as the catalog); Azure's pipelines by name, no text.
   */
  workflowFiles: (source: PipelineSource) => Promise<Answered<CiWorkflowFile[]>>;
  /**
   * The workflows a person may run by hand and their inputs, read from their files at `ref`
   * (none: the default branch). Azure answers none, for now.
   */
  dispatchable: (source: PipelineSource, ref?: string) => Promise<Answered<DispatchWorkflow[]>>;
  /**
   * Workflow `file` run by hand on `ref` with `inputs`, then its run once the provider lists it
   * (null when it is not listed in time). Azure: `unsupported`.
   */
  dispatch: (
    source: PipelineSource,
    file: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ) => Promise<Answered<PipelineRun | null>>;
  /** One run read in full: its stages and the gates the waiting ones stand at. */
  run: (source: PipelineSource, id: string) => Promise<Answered<PipelineRun>>;
  /** An attempt's jobs, graph edges and artifacts (none: the latest attempt). */
  inspect: (source: PipelineSource, id: string, attempt?: number) => Promise<Answered<Inspection>>;
  /** A job's whole log; null while it has none yet. */
  log: (source: PipelineSource, run: string, job: string) => Promise<Answered<string | null>>;
  /** A rerun or a cancel of `attempt` (the one inspected). */
  control: (
    source: PipelineSource,
    id: string,
    attempt: number,
    control: RunControl,
  ) => Promise<Answered<null>>;
  /** The gate's deployment approved (GitHub: the run's pending deployment; Azure: the approval). */
  approve: (source: PipelineSource, run: string, gate: Gate) => Promise<Answered<null>>;
  /** Who you are on the provider (GitHub's login); null where it does not say. */
  me: (source: PipelineSource) => Promise<Answered<string | null>>;
};

/** A port's answer: its data, or why the outside system refused or failed. */
export type Answered<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; profile?: string | undefined } };

/** Short-lived AWS credentials, as STS answers them; `expiration` is RFC 3339. */
export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
};

/** AWS as the box's role (or, on the Mac, the person's SSO): only what Reach needs. */
export type Aws = {
  /** One `sts:AssumeRole` with SourceIdentity set: CloudTrail shows who. */
  assumeRole: (input: {
    roleArn: string;
    sessionName: string;
    sourceIdentity: string;
    durationSeconds: number;
    region: string | null;
  }) => Promise<Answered<AwsCredentials>>;
};

/** Where secret values are kept (Secrets Manager): a database URL is read here, never from a layer file. */
export type Secrets = {
  read: (input: { secret: string; region: string | null }) => Promise<Answered<string>>;
};

/**
 * The person's login secret and its seeds (Secrets Manager in the tooling account, #55), on
 * serve's own credentials (the box's role). A value is read whole and written whole, never
 * printed or put on a command line.
 */
export type LoginStore = {
  /** The secret's current value and when it was made; `null`: no such secret, or no value yet. */
  read: (secret: string) => Promise<Answered<{ text: string; createdAt: string } | null>>;
  write: (secret: string, text: string) => Promise<Answered<null>>;
};

/**
 * One tool's check run the way `serve` runs it (#108 `abe tools check`): looked up on serve's own
 * PATH, run to its end with a short timeout. Never throws: not found, or where it was, its exit
 * and output. `managers`: the node version managers on this Mac (#145), for node's fix.
 */
export type ToolProbe = {
  run: (argv: readonly string[]) => Promise<ToolRan>;
  /** The check run with every copy of the tool on PATH, in PATH order (claude's, #179). */
  runEach: (argv: readonly string[]) => Promise<readonly ToolRan[]>;
  managers: () => Promise<readonly FoundManager[]>;
};

/** The login tools' own CLIs, as the person (their `HOME`). */
export type LoginTools = {
  /**
   * What the tool says of its login (`gh auth status`, `az account get-access-token`, `claude
   * auth status`, `aws sts get-caller-identity --profile <profile>`), or why it could not say
   * (not on serve's PATH, a claude failing on its model). `profile`: aws's SSO profile;
   * `azureConfigDir`: az's login folder, `githubAccount` the gh login asked for, in force at a
   * checkout (ADR 0025).
   */
  check: (
    tool: LoginTool,
    o?: { profile?: string; azureConfigDir?: string; githubAccount?: string },
  ) => Promise<LoginCheck>;
  /** `gh auth login --with-token`: GitHub's seed, the token on stdin. */
  githubToken: (token: string) => Promise<Answered<null>>;
};

/**
 * Cards on Azure DevOps Boards, as the person (`az`'s login), on the board the settings name.
 * Every call answers its data or a `BoardError`; none throws. Writes are seen by the next read.
 */
export type Board = {
  /**
   * The board's open cards (its types, in its team's areas), newest change first: only yours
   * (`mine`), only those in a sprint (`iteration`: its path, from `currentSprint`), and the done
   * ones `done` names (#239).
   */
  list: (
    board: BoardRef,
    query: { mine: boolean; iteration?: string; done?: DoneCards },
  ) => Promise<Boarded<CardData[]>>;
  /** The team's current sprint, or `null` when no iteration of the team spans today. */
  currentSprint: (board: BoardRef) => Promise<Boarded<Sprint | null>>;
  /**
   * What changed on the board after `since` (#236), Azure DevOps' time from the last look's `at`:
   * one query, usually empty; only the changed cards are read, each said as `card list --closed`
   * lists it now (the sprint read then) or gone from the board. `since` null: nothing changed, only
   * where the next look starts.
   */
  changes: (board: BoardRef, since: string | null) => Promise<Boarded<BoardChanges>>;
  /** The card with its comments, oldest first. */
  show: (board: BoardRef, id: number) => Promise<Boarded<CardDetail>>;
  /**
   * An image in a card's text or comments read into a local file (#238), its path: only an
   * attachment of the board's own organization (`boardAttachment`), with the board's token;
   * anything else is `rejected` unread. A file read once is kept and not read again.
   */
  image: (board: BoardRef, url: string) => Promise<Boarded<string>>;
  /** `markdown` as a new comment on the card. */
  comment: (board: BoardRef, id: number, markdown: string) => Promise<Boarded<CardCommentData>>;
  /** Tags added and taken off (`retag`), written only while the card is unchanged. */
  tag: (
    board: BoardRef,
    id: number,
    change: { add: readonly string[]; remove: readonly string[] },
  ) => Promise<Boarded<CardData>>;
  /** The card's state set; a state its type does not have is `rejected`. */
  move: (board: BoardRef, id: number, state: string) => Promise<Boarded<CardData>>;
  /**
   * The card assigned (B2, #213): to you (the login Azure DevOps knows the token by), to no one,
   * or to a teammate by their login.
   */
  assign: (board: BoardRef, id: number, who: AssignTo) => Promise<Boarded<CardData>>;
  /** The team's members (`teams/<team>/members`), each marked when they are you; in any order. */
  members: (board: BoardRef) => Promise<Boarded<BoardMember[]>>;
  /** You, as Azure DevOps knows the token: whose a card is. */
  me: (board: BoardRef) => Promise<Boarded<Person>>;
  /**
   * A new card (Make card #82, New card #346) in the team's area, its long fields kept as
   * markdown: of its `type` (one of the board's; else its first), in its `state` (else the type's
   * first), assigned to you with `assignee: 'me'`, in the team's current sprint when it has one
   * unless `sprint: 'none'`, linked as the child of its `parent` when given. A state or type Azure
   * does not take is `rejected`.
   */
  create: (board: BoardRef, card: NewCard) => Promise<Boarded<CardData>>;
  /**
   * A file attached to the card (#351: a prototype's screenshots, shown inline in its comment):
   * where Azure DevOps keeps it, to link from markdown.
   */
  attach: (
    board: BoardRef,
    id: number,
    file: { name: string; bytes: Uint8Array },
  ) => Promise<Boarded<{ url: string }>>;
  /**
   * The given fields of the card replaced, the others left as they are (Make card on its card,
   * #351: only its description, with its Prototype section).
   */
  write: (
    board: BoardRef,
    id: number,
    text: Partial<CardFields & { title: string }>,
  ) => Promise<Boarded<CardData>>;
};

/** A card's long fields as Make card writes them. */
export type CardFields = { description: string; acceptanceCriteria: string };

/** A card written from nothing (`abe card create`, Make card): what is left out is the board's default. */
export type NewCard = CardFields & {
  title: string;
  type?: string | undefined;
  state?: string | undefined;
  assignee?: 'me' | 'none' | undefined;
  sprint?: 'current' | 'none' | undefined;
  /** Its tags (#351: Make card's `prototype`). */
  tags?: readonly string[] | undefined;
  /** The card it is a child of (a ticket the to-tickets skill cuts from its card's spec). */
  parent?: number | undefined;
};

/**
 * Where sessions run: a worktree on the card's branch with `claude` in a terminal session that
 * can be attached. Local is `tmux` on the Mac (`ports/src/mac/tmux.ts`); in the cloud each session is
 * its own box (a workspace container there), behind this same interface, so `serve`'s rules do not change.
 */
export type SessionRunner = {
  /** The command a session runs `abe` with (a shell word): its hooks' commands start with it. */
  abe: string;
  /** Where the session's `abe` is: first on its `PATH`. */
  bin: string;
  /**
   * Local only: where each launch writes core's plugin (`<plugins>/<id>`), read-only to sessions.
   * A local runner's sessions get `sessionBoundary`; a workspace's container is its own.
   */
  plugins?: string;
  /** In a workspace: the session's `HOME` and `USER` inside its container. */
  home?: string;
  user?: string;
  /**
   * The source servers a session in `repo` launches with (ADR 0031): the repo's `sources:`
   * (`sources`), locally a bare name's from the Claude Code config of `home` (its main checkout's
   * local scope, then the user scope's); in a box's workspace (3.2.1) only those with their
   * definition (the Mac's synced `abe.yaml`), a bare name missing. Serve takes its sources' rules
   * from them.
   */
  sourceServers?: (o: {
    repo: string;
    sources: readonly SourceEntry[];
    home: string;
  }) => SourceServers;
  /**
   * The session's own socket: the path `serve` listens on (`listen`, with `mode`) and the path the
   * session reaches it by (`session`, its `ABE_SOCKET`): the same locally, the mount's in a container.
   */
  socket: (id: string) => { listen: string; session: string; mode: number };
  /**
   * Makes (or reuses) the worktree on `branch` from `repo` (in a workspace: the clone it holds),
   * writes the settings `claude` is given and starts `claude` with exactly `env` (and the launch
   * prompt) in an attachable terminal.
   */
  launch: (spec: {
    id: string;
    repo: string;
    branch: string;
    /**
     * Where `branch`, not there yet, is made from: the first of these refs that is a commit once
     * origin is fetched (a pipeline fix's: the failed revision); default origin's default branch.
     */
    from?: readonly string[];
    /**
     * An Improve retro chat's own folder (#87): made if missing, trusted, and its working folder
     * in place of a worktree (no branch, no setup). Local runners only.
     */
    folder?: string;
    claudeSession: string;
    /**
     * A moved session (#88): its transcript, kept as a log at `transcript` (relative to the
     * worktree), written as Claude Code's own session file for the worktree first (its `cwd` the
     * worktree's, `from` before), and `claude --resume <claudeSession>` in place of a new one.
     */
    resume?: { transcript: string; from: string };
    /**
     * A reopened session (#343): `claude --resume <claudeSession>` on the conversation Claude Code
     * keeps for the worktree, nothing copied. Its worktree is made again only from `branch` as it
     * is: a branch gone is refused (`worktree-gone`), never made anew.
     */
    reopen?: boolean;
    prompt: string;
    /** Core's instructions (`CORE_INSTRUCTIONS`), after Claude Code's own system prompt. */
    instructions: string;
    settings: ClaudeSettings;
    /** Core's plugin, written to `<plugins>/<id>` and loaded with `--plugin-dir`. */
    plugin: readonly PluginFile[];
    /** The `skillsOnTop` setting: the person's own skills, plugins and rules load too. */
    skillsOnTop: boolean;
    env: Readonly<Record<string, string>>;
    /** A workspace's managed settings, written where only root writes (`MANAGED_SETTINGS`). */
    managed?: ClaudeSettings;
    /**
     * With `managed`: the files its commands never see, as the container has them (`boxJailScript`'s
     * `off`): the environments off for agents', their Abe env files and the repo env files feeding
     * only them.
     */
    offFiles?: readonly string[];
    /**
     * `session.mcp` for this launch: `yours` loads the person's own MCP servers too (a local
     * runner names their `~/.claude.json`) and their claude.ai connectors, the repo's `.mcp.json`
     * servers rejected in its settings; `abe-only` only Abe's (`--strict-mcp-config`).
     */
    mcpMode: SessionMcp;
    /** Abe's own MCP config for the session (the workspace's browser). */
    mcpConfig?: string;
    /**
     * `abe-only` in a Factory run or a box's session: its sources (`names`), never from a repo's
     * `.mcp.json`; the runner tells the session of them after `instructions` (`sourcesTold`), which
     * did not load too, `local` when the checkout is in local mode. On this Mac `servers` are
     * `sourceServers`' whose install check passed (ADR 0027, `checkedSourceServers`), written as the
     * config Abe generates for the session, out of the sandbox's reach, and `missing`, `withheld`
     * and `unchecked` (no check passed) those that did not load; on a box the same, the checks the
     * Mac's install's (`SessionSync.checked`), each signed in with the Mac's token (3.2.1).
     */
    sources?: {
      names: readonly string[];
      local: boolean;
      servers?: Readonly<Record<string, unknown>>;
      missing?: readonly string[];
      withheld?: readonly string[];
      unchecked?: readonly string[];
    };
    /**
     * A local session's MCP config (its own browser, #182), once its worktree is known: the file
     * written for that worktree, passed as `mcpConfig` is. Local runners only.
     */
    mcp?: (worktree: string) => string;
    /** Files written under the session's home first (its AWS profiles), path relative to it. */
    files?: readonly { path: string; text: string }[];
    /**
     * The repo pack's setup (`setup`), run in a worktree made now, before `claude`: locally with
     * `env`, its network the package registries alone, when its packages cannot be linked from the
     * main checkout (`prepareWorktree`); in a box's workspace in its clone with the container's own
     * environment, until it passed.
     */
    setup: string | null;
    /**
     * Files and folders of the main checkout, from its top, a local worktree made now gets copied
     * in when absent (the team's untracked files, yours for the repo, the Abe env files, what the
     * repo's worktree recipe lists).
     */
    copy?: readonly WorktreeCopy[];
    /**
     * The repo's worktree recipe's script (`hooks.worktree-setup`, from the top), run last in a worktree
     * made now, as serve outside the session's sandbox: locally the main checkout's, with its
     * network open; in a box's workspace the clone's, once it passed. None: none.
     */
    worktreeRun?: string | null;
    /** The card the session is on (the recipe's script's `CARD`); none: no card. */
    card?: string | null;
    /**
     * `clone`: a prototype session's worktree made now (ADR 0039): each `node_modules` of the main
     * checkout cloned in copy on write, the lockfile's install only when its manifests differ.
     * None: linked from the main checkout, as a card's. Local runners only.
     */
    packages?: 'clone';
    /**
     * Of the person's own MCP servers (their Claude Code config's `mcpServers`), those this launch
     * loads whatever `mcpMode` says (a prototype session's Figma server, core's `figmaServers`);
     * with `abe-only` written into the config Abe generates beside the sources. None: none.
     * Local runners only.
     */
    ownServers?: (servers: Readonly<Record<string, unknown>>) => readonly string[];
  }) => Promise<
    Answered<{
      worktree: string;
      setup: SetupRan | null;
      /** False: Claude Code asks whether to trust the folder before any hook (answered by attaching). */
      trusted: boolean;
      /** A branch made now: where from (#198); absent when it was there already, or on a box. */
      base?: BranchBase;
      /** Of `sources`, those no MCP config there names: not loaded. Absent: none. */
      sourcesMissing?: string[];
    }>
  >;
  /**
   * Makes (or moves) the worktree at the merge base of `branch` and the default branch, beside
   * `repo`'s own worktrees (`baseWorktreePath`), detached: where Before reproduces a bug.
   */
  baseWorktree: (
    repo: string,
    branch: string,
    /**
     * The repo's worktree recipe, applied each time it is made or moved: its files (as a card's
     * worktree gets them), its packages linked when they can be, and its script; the script's
     * failure refuses it (`worktree-setup-failed`).
     */
    recipe?: { copy: readonly WorktreeCopy[]; run: string | null; card: string | null },
  ) => Promise<
    Answered<{
      path: string;
      base: string;
      against: string;
      /** Why `against` may be stale: origin not reached (#198). */
      note?: string;
    }>
  >;
  /** Types `text` into the session's terminal, then Enter. */
  send: (id: string, text: string) => Promise<Answered<null>>;
  /** Presses `keys` in the session's terminal, one after another (tmux's names: `Down`, `s`). */
  keys: (id: string, keys: readonly string[]) => Promise<Answered<null>>;
  /** What the session's terminal shows now: tmux's capture of its pane, a line a row. */
  screen: (id: string) => Promise<Answered<string>>;
  /** The command that puts a terminal in the session (run by the person's own terminal). */
  attach: (id: string) => string[];
  /** Ends the session's `claude` and its terminal; the worktree stays. Gone already is fine. */
  stop: (id: string) => Promise<Answered<null>>;
  /** The ids of the sessions whose `claude` still runs. */
  running: () => Promise<Answered<string[]>>;
  /** Whether any terminal is attached to a session now (the box's idle stop asks, #92). */
  attached?: () => Promise<boolean>;
};

/**
 * How the Mac reaches a box (ADR 0021, #91): `abe <argv>` run there and its ports, over SSH
 * through the box's EC2 Instance Connect Endpoint (`eiceLink`: a fresh key per connection, abe's
 * own tunnel client, the t50b spike's ssh options); on a Mac's Docker, `docker exec` into the
 * stand-in box. Nothing here decides.
 */
export type BoxLink = {
  /** `abe <argv>` on the box, to its end: what it printed and its exit (3: its serve did not answer). */
  run: (box: string, argv: readonly string[]) => Promise<Ran>;
  /** A long-running `abe <argv>` (`watch`), each stdout line handed on, until `stop` or its end. */
  follow: (
    box: string,
    argv: readonly string[],
    onLine: (line: string) => void,
  ) => { stop: () => void; ended: Promise<number> };
  /** The command that puts the person's terminal in `abe <argv>` on the box (`abe box attach … --`). */
  attach: (box: string, argv: readonly string[]) => string[];
  /**
   * A port on this machine (127.0.0.1) that reaches `port` on the box, until `stop`; a dropped
   * network is mended behind it. Answers once the local port takes connections. `local`: the
   * ports to take here, the first free one (#16); none free is `port-taken`. Without: any free.
   */
  forward: (box: string, port: number, local?: readonly number[]) => Promise<Answered<Forwarded>>;
  /** Lets go of what it holds (the EC2 Instance Connect link's private key folder) when serve stops. */
  close?: () => void;
};

/** `BoxLink.forward`'s answer: `ended` says why it stopped mending itself ('' after `stop`). */
export type Forwarded = { port: number; stop: () => void; ended: Promise<string> };

/** The person's logins a box restores into its workspace (ADR 0016: stored once, read by their boxes only). */
export type LoginSet = {
  /** Claude Code's (`claude setup-token`): the session's `CLAUDE_CODE_OAUTH_TOKEN`. */
  claude: string;
  /** GitHub's: `gh`'s login, and git's through it. */
  github: string;
};

/** Where the logins are kept: Secrets Manager in the tooling account, read as the box (#55). */
export type Logins = { read: () => Promise<Answered<LoginSet>> };

/**
 * The box's own machine (#92): powering it off from its `serve` once idle, so EC2 stops it (the
 * launch template's instance-initiated shutdown is `stop`: the disk is kept).
 */
export type BoxHost = {
  /** `shutdown -h now`; answers once it is under way (the process then ends with the machine). */
  shutdown: () => Promise<Answered<null>>;
  /** Whether someone is logged in to the box with a terminal (`abe box attach`'s SSH). */
  attached: () => Promise<boolean>;
  /**
   * This boot of the box (Linux's `boot_id`): a keep awake set in another boot is gone (#104:
   * waking a box does not restore it). None or null: not known.
   */
  boot?: () => Promise<string | null>;
  /** Its memory, CPU counters and root disk now (`/proc/meminfo`, `/proc/stat`, the root's statfs). */
  load?: () => Promise<Omit<HostLoad, 'volumes'>>;
  /**
   * Its root disk grown (ADR 0022): EC2 grows the instance's root volume (the box role's
   * `abe-box-disk`) to `rootVolumeTarget` of its own size under `maxGb`, then its partition and
   * filesystem take the room (`sudo -n abe-grow-root`). Its root's size and room after, and the
   * volume's size asked for (null: at `maxGb` already, nothing done).
   */
  growRoot?: (
    maxGb: number,
  ) => Promise<Answered<{ totalBytes: number; freeBytes: number; toGb: number | null }>>;
};

/** What a process printed and exited with. */
export type Ran = { exit: number; stdout: string; stderr: string };

/** A volume (made on first use) or a path on the box, mounted into a container. */
export type Mount = { type: 'volume' | 'bind'; source: string; target: string; readOnly?: boolean };

export type ContainerSpec = {
  image: string;
  name?: string;
  hostname?: string;
  /** The command, in place of the image's. */
  argv?: readonly string[];
  labels: Readonly<Record<string, string>>;
  env: Readonly<Record<string, string>>;
  mounts: readonly Mount[];
  /** A network's name, or `none`. */
  network: string;
  /** Ports published on the host (`--publish host:port:target`): the Mac database's loopback port. */
  publish?: readonly { host: string; port: number; target: number }[];
  workdir?: string;
  limits?: { memory: string; pids: number; shm: string };
  /** Every capability dropped and no new privileges. */
  hardened?: boolean;
  /** A seccomp profile's path on the box. */
  seccomp?: string;
  /**
   * The AppArmor profile it runs under, loaded on the box host (in Docker's docker-default's place,
   * whose `deny mount` keeps a sandbox such as Claude Code's bwrap from building its root). Only
   * the workspace's own: no container is ever made unconfined.
   */
  apparmor?: typeof WORKSPACE_APPARMOR;
  /**
   * Docker's masks over /proc lifted (`systempaths=unconfined`), so a sandbox in its own user and
   * pid namespace (a box session's jail) mounts a /proc of its own. Only the workspace's.
   */
  systemPaths?: typeof WORKSPACE_SYSTEM_PATHS;
  /** Docker starts it again after a crash or the box's start. */
  restart?: 'unless-stopped';
};

/** A container as Docker lists it: `state` is Docker's (`running`, `exited`, …). */
export type Container = { name: string; state: string; labels: Readonly<Record<string, string>> };

export type Image = { id: string; labels: Readonly<Record<string, string>> };

/**
 * The box's Docker. A call Docker refuses rejects with its message; `build`, `once` and `exec`
 * answer the command's own exit instead.
 */
export type Docker = {
  /** Every container, in any state, carrying the label `key=value`. */
  containers: (key: string, value: string) => Promise<Container[]>;
  /** The image, or `undefined` when the box has none by that name. */
  image: (ref: string) => Promise<Image | undefined>;
  /**
   * Builds `context` with its `dockerfile` (a path inside it) into `tag`; `contexts` are named
   * build contexts beside it (`--build-context name=dir`, the base image's `abe-bin`).
   */
  build: (b: {
    tag: string;
    context: string;
    dockerfile: string;
    contexts?: Readonly<Record<string, string>>;
    args: Readonly<Record<string, string>>;
    labels: Readonly<Record<string, string>>;
    /** Each line of the build's output as it comes: its progress (#142). */
    progress?: (line: string) => void;
  }) => Promise<Ran>;
  /** Makes the network when it is missing. */
  network: (name: string) => Promise<void>;
  /** Removes the network (gone already is fine). */
  removeNetwork: (name: string) => Promise<void>;
  /** Starts a long-running container. */
  run: (spec: ContainerSpec) => Promise<void>;
  /** Runs a container to its end and removes it. */
  once: (spec: ContainerSpec) => Promise<Ran>;
  /**
   * The AppArmor confinement a throwaway container of `image` under `apparmor` runs in, as the
   * kernel names it (`abe-workspace (enforce)`; `unconfined` on a host with AppArmor off, where
   * Docker applies no profile at all). Rejects when Docker refuses it (the profile not loaded).
   */
  confinement: (image: string, apparmor: typeof WORKSPACE_APPARMOR) => Promise<string>;
  /**
   * Runs `argv` in a running container as its user (or `user`), `stdin` written to it; one that
   * runs past `timeoutMs` (default a minute) is killed and answers exit 124.
   */
  exec: (
    name: string,
    argv: readonly string[],
    stdin?: string,
    o?: { user?: string; timeoutMs?: number },
  ) => Promise<Ran>;
  start: (name: string) => Promise<void>;
  /** Removes the container, running or not (its named volumes stay). */
  remove: (name: string) => Promise<void>;
  /** Removes the named volume (gone already is fine); one a container still mounts is refused. */
  removeVolume: (name: string) => Promise<void>;
  /** Where the named volume's files are on the box host (its mountpoint); none: no such volume. */
  volumePath: (name: string) => Promise<string | undefined>;
  /** Each volume's size on disk in bytes, by name (`docker system df -v`: a box's load). */
  volumeSizes: () => Promise<Record<string, number>>;
};

/**
 * A box's relays into its workspaces (#16): a listener on the box's own 127.0.0.1 (a free port)
 * whose every connection runs `abe port pipe <port>` in the container (`docker exec -i`) and
 * pipes bytes both ways; the pipe ends with the connection and the connection with the pipe.
 */
export type WorkspaceRelays = {
  open: (container: string, port: number) => Promise<RelayHeld>;
};

/** One relay listening: its port on the box's 127.0.0.1; `close` ends it and its connections. */
export type RelayHeld = { port: number; close: () => Promise<void> };

/** Each repo's bare mirror on the box: what the workspace clones from and its image builds from. */
export type Mirrors = {
  /** Fetches the repo's mirror (cloning it the first time); its path on the box. */
  sync: (repo: string) => Promise<string>;
  /** The tree id of `path` at the default branch's head, or `undefined` when it has none. */
  tree: (repo: string, path: string) => Promise<string | undefined>;
  /** The default branch's head unpacked into a fresh directory; its path. */
  snapshot: (repo: string) => Promise<string>;
  /**
   * The box's own checkout of the repo at its mirror's default branch (made, or moved to the
   * mirror's head): what a run's settings are read in, never the workspace's clone the agent
   * writes. Its path on the box.
   */
  checkout: (repo: string) => Promise<string>;
};

/**
 * What a check's command left: its exit (null when killed) and the tail of what it printed.
 * `keys`: the names of the variables it got, sorted (never a value); absent when the tree cannot
 * say (a box's container).
 */
export type ShellRan = {
  exit: number | null;
  output: string;
  timedOut: boolean;
  keys?: readonly string[];
};

/**
 * A port asked for by the card whose work it touches: on a box each card's workspace is a
 * container of its own (ADR 0022), so its git, run tree and transcripts are that container's;
 * elsewhere one serves every card.
 */
export type ByCard<T> = (card: number | string | null) => T;

/**
 * A Factory run's worktree, wherever it is (#67): on this machine's disk for a local run, inside
 * the box's workspace container for a run on a box (through `docker exec`: the clone is on the
 * workspace's volume, never on the box's own disk). Paths are the worktree's own.
 */
export type RunTree = {
  /** Whether the worktree is there. */
  exists: (worktree: string) => Promise<boolean>;
  /**
   * A report file the agent named, as text: `path` absolute or relative to the worktree (on a
   * box, only a file inside it once links are followed: serve reads it outside the sandbox).
   */
  report: (worktree: string, path: string) => Promise<Answered<string>>;
  /** Writes `path` in the worktree whole (its folders made; on a box, only inside the worktree). */
  write: (worktree: string, path: string, text: string) => Promise<Answered<null>>;
  /** How many files `dir` holds itself, its folders (a report's Evidence) not counted; 0 when it is not there. */
  count: (dir: string) => Promise<number>;
  /** The folders `dir` holds itself, by name (links not followed); none when it is not there. */
  folders: (dir: string) => Promise<string[]>;
  /**
   * A session's log sources where it ran (core's `logSourcesOf(…).session`: its transcript, the
   * card's checks, reports and Evidence), each read only inside its `within` folder.
   */
  logs: (sources: LogSources) => Promise<LogsRead>;
  /**
   * A check's command in `cwd`, in the worktree's environment with `CI=true`, killed after
   * `timeoutMs`. `env`: variables over it (a local session's own `DATABASE_URL`, #146).
   */
  shell: (o: {
    run: string;
    cwd: string;
    timeoutMs: number;
    env?: Readonly<Record<string, string>>;
  }) => Promise<ShellRan>;
  /** The worktree as it is now against its merge base with the default branch. */
  diff: (worktree: string) => Promise<BaseDiff>;
  /** Its branch's commits since that merge base, oldest first, each its short sha and subject. */
  commits: (worktree: string) => Promise<Answered<MadeCommit[]>>;
  /** Where the session's Chat is read: its transcript files, its worktree's snapshots (#113). */
  transcript: TranscriptFiles;
};

/** A file's bytes read from an offset on, and its whole size then. */
export type FileTail = { bytes: Uint8Array; size: number };

/** A diff between two trees: the files that differ (relative paths) and git's patch text. */
export type TreeDiff = { names: string[]; patch: string };

/**
 * What Chat reads where a session runs (#113; on a box, inside the workspace container): its
 * transcript JSONL files, and its worktree's files as git trees, so a turn's changes are the
 * worktree's whoever wrote them (an Edit, a Bash `sed`, a merged subagent).
 */
export type TranscriptFiles = {
  /**
   * `path`'s bytes from `offset` on; undefined when it is not there. Read only when it is no link
   * and, links in its folders resolved, inside `within` (a hook's `transcript_path` is the
   * session's to give).
   */
  tail: (path: string, offset: number, within: string) => Promise<Answered<FileTail | undefined>>;
  /** The regular files directly in `dir` (their names), none when it is not there; only inside `within`. */
  list: (dir: string, within: string) => Promise<string[]>;
  /**
   * The worktree's files as they are now, staged or not, untracked too (ignored ones and writers'
   * worktrees not), as a git tree: written to the object store only, the index and files untouched.
   */
  snapshot: (worktree: string) => Promise<Answered<string>>;
  /** What differs between two trees (only `paths`, when given), the patch with 3 lines of context. */
  diff: (
    worktree: string,
    from: string,
    to: string,
    paths?: readonly string[],
  ) => Promise<Answered<TreeDiff>>;
  /**
   * `paths` put back in the worktree as `tree` has them, the index untouched; one the tree lacks
   * is removed (`removed` names those that were there).
   */
  restore: (
    worktree: string,
    tree: string,
    paths: readonly string[],
  ) => Promise<Answered<{ removed: string[] }>>;
};

/** What DevTools answers about a running browser. */
export type BrowserProbe = {
  /** The pid its start wrote, or `null` for a browser this `serve` did not start. */
  pid: number | null;
  /** `/json/version`'s `Browser`: `Chrome/156.0.8078.47`. */
  version: string;
  /** `/json/version`'s `webSocketDebuggerUrl`. */
  webSocket: string;
  /** `/json/list`'s pages. */
  pages: { id: string; url: string; title: string }[];
  /** DevTools clients connected now (chrome-devtools-mcp, a live view). */
  clients: number;
};

/**
 * Headless Chromium in the workspace (on a box, inside its container). `dir` holds its pid file,
 * log and profile.
 */
export type Browser = {
  /** Runs `argv` in the background and answers once DevTools answers on `port`. */
  start: (b: {
    dir: string;
    port: number;
    argv: readonly string[];
  }) => Promise<Answered<{ pid: number }>>;
  /** What DevTools answers on `port` now, or `undefined` when nothing does. */
  probe: (b: { dir: string; port: number }) => Promise<BrowserProbe | undefined>;
  /** Stops the browser `dir`'s pid file names, and waits until it is gone. */
  stop: (b: { dir: string }) => Promise<void>;
  /**
   * A profile's sign-ins set into the browser answering on `port` (#103): its cookies into the
   * default context, each origin's local storage through a setup tab of that origin whose
   * request DevTools answers itself (nothing reaches the site), closed after.
   */
  restore: (b: {
    port: number;
    state: StorageState;
  }) => Promise<Answered<{ cookies: number; origins: number }>>;
};

/**
 * Google Chrome on the Mac, on a browser profile's own folder (#103; 1.0's rules: its
 * `--user-data-dir`, a debugging port Chrome picks and writes in the folder's
 * `DevToolsActivePort`): where you sign in once, and where `abe browser store` reads the sign-ins.
 */
export type Chrome = {
  /**
   * Chrome on `dir`, a tab per URL: the one running gets them, else one starts and is waited for.
   * `front`: it comes up in front of the window in front (else behind it).
   */
  open: (b: {
    dir: string;
    urls: readonly string[];
    front?: boolean;
  }) => Promise<Answered<{ endpoint: string; started: boolean }>>;
  /**
   * The Chrome running on `dir` (DevTools on `endpoint`) brought to the front: its tab in front
   * activated, or a new window where it has none. Never a second Chrome.
   */
  front: (b: { dir: string; endpoint: string }) => Promise<Answered<null>>;
  /** DevTools' HTTP endpoint of the Chrome running on `dir`, or `undefined` when none answers. */
  running: (dir: string) => Promise<string | undefined>;
  /**
   * Its sign-ins through DevTools: every cookie, and the local storage of `stateOrigins` (a
   * background setup tab per origin). `cookiesOnly`: the cookies alone, no tab opened (origins
   * empty), cheap enough to read every few seconds.
   */
  read: (endpoint: string, o?: { cookiesOnly?: boolean }) => Promise<Answered<SignIns>>;
};

/** A profile's stored sign-ins: its secret and when it was last written. */
export type StoredProfile = { name: string; secret: string; storedAt: string };

/**
 * Your browser profiles' sign-ins (#103), one secret each beside your logins in the tooling
 * account (`abe/<person>/browser/<name>`). A value goes in on stdin and comes out whole; never
 * on a command line, in a reply, an event or a log.
 */
export type ProfileStore = {
  /** Every profile of yours with something stored. */
  list: () => Promise<Answered<StoredProfile[]>>;
  /** A profile's stored text; `null`: nothing stored. A secret that cannot be read: `profile-unreadable`. */
  read: (
    name: string,
  ) => Promise<Answered<{ secret: string; text: string; storedAt: string } | null>>;
  /** Writes it whole; a first write makes the secret, fenced as your logins are. */
  write: (name: string, text: string) => Promise<Answered<{ secret: string }>>;
  /** Deletes its secret (gone already counts). */
  remove: (name: string) => Promise<Answered<null>>;
};

/** One object in the org store: its key and size in bytes. */
export type StoredObject = { key: string; size: number };

/**
 * The org store: objects by key, shared by everyone in the org (`$ABE_ORG_STORE`: the bucket in
 * the tooling account, `s3://<bucket>`; a folder in tests, `file://<dir>`). Keys are `/`-separated
 * paths (`sheets/<card>/<sheetId>/v<n>.html`, `prototypes/<repo>/<card>/v<n>/…`, core's
 * `orgKeyProblem`). Every call answers or says why
 * not (`not-found` for a key it does not hold, `bad-key`, `store-failed`); none throws.
 */
export type OrgStore = {
  /** Writes the object whole, replacing one at that key. */
  put: (key: string, body: Uint8Array, contentType: string) => Promise<Answered<StoredObject>>;
  get: (key: string) => Promise<Answered<Uint8Array>>;
  /** Every object whose key starts with `prefix`, by key. */
  list: (prefix: string) => Promise<Answered<StoredObject[]>>;
};

/**
 * Where `abe sheet open` serves a Sheet: each page on a local origin of its own that answers that
 * page, with `headers`, at one path and nothing else. The same `key` again is the same URL.
 */
export type SheetHost = {
  open: (page: {
    key: string;
    html: Uint8Array;
    headers: Readonly<Record<string, string>>;
  }) => Promise<{ url: string }>;
  /** Stops every origin it opened. */
  close: () => Promise<void>;
};

/**
 * The log store (ADR 0019): every session's redacted logs under `<team>/<github-login>/<session>/`
 * (core's `logKey`). `$ABE_LOG_STORE=file://<dir>` is a folder (`ports/src/aws/log-store.ts`),
 * `s3://<bucket>[/<prefix>]` the bucket in the tooling account (`ports/src/aws/s3-store.ts`, #58). Every call answers or
 * says why not (`bad-key`, `store-failed`); none throws.
 */
export type LogStore = {
  /** Writes the object whole, replacing one at that key: shipping again is safe. */
  put: (key: string, body: Uint8Array, contentType: string) => Promise<Answered<StoredObject>>;
  /** The object at `key` (`not-found` for none): what a retro reads. */
  get: (key: string) => Promise<Answered<Uint8Array>>;
  /** Every object whose key starts with `prefix`, by key. */
  list: (prefix: string) => Promise<Answered<StoredObject[]>>;
};

/** What a script run to its end printed and exited with; exit null: killed at its time. */
export type ScriptRan = { exit: number | null; stdout: string; stderr: string };

/**
 * What a local session runs outside its sandbox (#182, #146), by `serve`: each script to its end
 * in a process group of its own, its output into files (an app it leaves running keeps them, and
 * no pipe waits on it).
 */
export type SessionApps = {
  /**
   * `script` (relative to `cwd`) with `args` and exactly `env`. `keep`: what it leaves running is
   * the session's (`abe run`'s apps), its group and `cwd` kept for `end`; else a one-off (the
   * database hook). The stop hook (`stop`) kept is followed by the groups kept for its `cwd`
   * stopped (TERM, then KILL) and no longer kept. A missing script exits 127, one not executable
   * 126, as a shell's.
   */
  run: (o: {
    id: string;
    cwd: string;
    script: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
    keep: boolean;
    /**
     * Paths the script and what it starts may not read: its session's never-read files, as its
     * sandbox keeps them from the session (macOS's `sandbox-exec`). None: it reads as it likes.
     */
    denyRead?: readonly string[];
    /** The repo's stop hook (`hooks.stop`), kept with what it leaves for `end`; none: today's place. */
    stop?: string;
  }) => Promise<ScriptRan>;
  /**
   * The session's apps ended: the stop hook kept with them run once in each worktree a kept script ran
   * in (with `env`), then each kept group sent TERM, then KILL; then every process still running
   * whose environment holds `socket` or the session's mark (`leftoverPids`). What it did, in words.
   */
  end: (o: {
    id: string;
    socket: string;
    env: Readonly<Record<string, string>>;
  }) => Promise<string[]>;
};

/** A Docker context and the daemon it reaches, as `docker context inspect` says. */
export type DockerEndpoint = { name: string; host: string };

/**
 * Docker compose on the local machine for a local session's pack scripts, through `docker` with
 * exactly the script's `env` (its `DOCKER_*`, its `HOME`'s `~/.docker`). Rules are core's
 * (`session/compose.ts`).
 */
export type Compose = {
  /** The context docker uses with `env` and its daemon; null: no Docker here to ask. */
  endpoint: (env: Readonly<Record<string, string>>) => Promise<DockerEndpoint | null>;
  /** The project's containers, networks and volumes removed (none there is fine). */
  down: (o: { project: string; env: Readonly<Record<string, string>> }) => Promise<Ran>;
  /**
   * `docker compose --project-name <project> <args…>` in `cwd`, `stdin` its input (a compose file
   * read elsewhere, `-f -`): a box's serve running a workspace's compose on the box.
   */
  run: (o: {
    project: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd: string;
    stdin?: string;
  }) => Promise<Ran>;
  /** `container` joined to `network` (`leave`: taken off it); already so is fine. */
  network: (o: {
    network: string;
    container: string;
    leave?: boolean;
    env: Readonly<Record<string, string>>;
  }) => Promise<Ran>;
};

/** What `PrototypeApps.head` read of a checkout: its top folder, remote, default branch and commit. */
export type PrototypeHead = { repo: string; remote: string | null; branch: string; commit: string };

/**
 * Where a prototype's app runs, at a commit, started by the repo's `prototype-start` hook, else
 * its `start`. Local (`ports/src/mac/prototype-apps.ts`): a detached worktree of the checkout in
 * `serve`'s state directory, so the checkout's status, branches and remotes never change. On a box
 * (#81) the workspace's, behind this same interface.
 */
export type PrototypeApps = {
  /**
   * The checkout's top folder, its `origin` remote and its default branch's newest commit as the
   * checkout knows it (the first of core's `defaultRefs` that resolves; nothing is fetched).
   */
  head: (repo: string) => Promise<Answered<PrototypeHead>>;
  /**
   * The checkout at `commit` in the prototype's own place, its start script (`hooks`'
   * `prototype-start`, else its `start`) run there to its end
   * with `serve`'s environment and `env`: its run, for core's `startAnswer`. A commit the checkout lacks, or no start script
   * at it, is refused.
   */
  start: (spec: {
    id: string;
    repo: string;
    commit: string;
    env: Readonly<Record<string, string>>;
    /**
     * A folder of its own to run the start script in instead (a developer's prototype's worktree,
     * #83): no worktree is made at `commit`, and `stop` leaves the folder where it is. Its
     * packages are made ready first (ADR 0039): the main checkout's `node_modules` cloned where it
     * has none, the lockfile's install when its manifests changed; a failed install refuses it.
     */
    dir?: string;
    /**
     * `start`: the repo's `start` hook only, never `prototype-start` (a repo whose app takes fixed
     * ports starts the normal way, ADR 0039). None: `prototype-start` where the place has it.
     */
    script?: 'start';
    /**
     * Files and folders of the checkout, from its top, put into the place when absent there
     * before the start script is looked for: what a card's new worktree gets (`worktreeCopies`),
     * so a `.abe/` the install kept out of git (Just this Mac) is there. Tracked ones stay the
     * commit's.
     */
    copy?: readonly WorktreeCopy[];
    /**
     * The repo's hook points (the main checkout's): its start scripts, and its `worktree-setup`
     * run in a place made now. None: today's places, no worktree script.
     */
    hooks?: RepoHooks;
    /**
     * Run in the place once it is there, before the start script (#349: its database, seeded):
     * what more the start gets in its environment, or why it does not run (refused with that).
     */
    prepare?: (
      dir: string,
    ) => Promise<
      { ok: true; env: Readonly<Record<string, string>> } | { ok: false; message: string }
    >;
  }) => Promise<
    Answered<{
      dir: string;
      ran: StartRun;
      /** The script it ran, from the place's top: `prototype-start` where the place has it, else `start`. */
      script?: string;
    }>
  >;
  /**
   * Ends prototype `id`'s start under way, if one is (its script's whole group killed), so the
   * start answers at once: failed, its script killed. None under way: nothing.
   */
  cancel?: (id: string) => void;
  /** The app's log of prototype `id`, its start's stdout (stderr beside it, `.err`); none: not kept. */
  log?: (id: string) => string;
  /**
   * Runs the stop script there (`hooks`' `prototype-stop`; its `stop` where it started by the
   * `start`; with `env` beside serve's), if it has one, ends what the start left running, and removes the
   * place (never a `dir` given). Gone is fine.
   */
  stop: (spec: {
    id: string;
    repo: string;
    env?: Readonly<Record<string, string>>;
    /** The repo's hook points; none: today's places. */
    hooks?: RepoHooks;
  }) => Promise<void>;
  /** A pack script (the `seed` hook) run to its end in `dir` with `env` beside serve's. */
  script: (spec: {
    id: string;
    dir: string;
    script: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
  }) => Promise<ScriptRan>;
};

/**
 * A page's screenshot by a headless browser of this machine (the install's Prototype check): the
 * PNG written to `file`, or why not (no Chrome or Chromium here, the page did not load in time).
 */
export type PageShot = (o: {
  url: string;
  file: string;
  width: number;
  height: number;
}) => Promise<{ ok: true } | { ok: false; why: string }>;

/**
 * The prototype proxy: one local origin per prototype in front of its app, routing every request
 * by core's `routeRequest` and giving HTML answers `PROTOTYPE_CSP`. Opened again it points the
 * same URL at the app given; `refused` is told each request it refuses.
 */
export type PrototypeProxy = {
  open: (p: {
    id: string;
    app: string;
    refused: (r: RefusedRequest) => void;
  }) => Promise<{ url: string }>;
  close: (id: string) => Promise<void>;
};

/**
 * A one-shot (`claude -p`, core's `oneShotArgv`): `prompt` on stdin, `system` after Claude Code's
 * own system prompt, `model`, run in `cwd` with exactly `env` (core's `oneShotEnv`), answered as
 * the text it printed. Killed after `timeoutMs` (`one-shot-timeout`); no `claude` on `env`'s
 * `PATH` is `no-claude`, any other exit `one-shot-failed`. None throws.
 */
export type OneShot = {
  ask: (q: {
    prompt: string;
    system: string;
    model: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
  }) => Promise<Answered<{ text: string }>>;
};

/** One thing a person said on a pull request: a comment, a review comment on a line, or a review. */
export type PullComment = {
  author: string;
  at: string;
  /** `comment`, `review` (with its state, `APPROVED` …) or `line` (a review comment on `path`). */
  kind: 'comment' | 'review' | 'line';
  state: string | null;
  path: string | null;
  body: string;
};

/** A pull request an earlier retro opened, found again by its label. */
export type LabelledPull = {
  repo: Repo;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt: string | null;
};

/**
 * What Improve retro (#86) reads from GitHub, as the person through `gh`: what people said on a
 * session's pull request, and the pull requests earlier retros opened (by their label).
 */
export type RetroPulls = {
  comments: (ref: Ref) => Promise<Tracked<PullComment[]>>;
  labelled: (repo: Repo, label: string) => Promise<Tracked<LabelledPull[]>>;
};

/**
 * A repo on GitHub as the person, through `gh api` (`ports/src/github/layer-pulls.ts`): the one way
 * a change to the repo Layer becomes a pull request (`abe workflow propose`, `abe improve retro
 * make`, `abe settings propose`). It is made with the Git Data API, so no checkout is touched.
 */
export type LayerPulls = {
  /** The default branch and its newest commit. */
  base: (repo: Repo) => Promise<Tracked<{ branch: string; sha: string }>>;
  /** A file's text at commit `sha`; null when it has none there. */
  show: (repo: Repo, sha: string, path: string) => Promise<Tracked<string | null>>;
  /**
   * One commit over `base.sha` on `branch` (each file written, `null`: removed; the branch is
   * this proposal's own, so one an earlier try left is moved to it), and its pull request into
   * `base.branch`, labelled when `label` is given (the label made first if the repo has none).
   * `nothing-to-propose` when the files already read so at `base.sha`. A file is written
   * executable when it ends `.sh` or sits under `scripts/`, else not (an existing file's mode is
   * not kept). With `pull`, the open pull request already on `branch`: the branch is moved to
   * the new commit and that pull request's title and body are updated, no second one opened.
   */
  propose: (input: {
    repo: Repo;
    base: { branch: string; sha: string };
    branch: string;
    title: string;
    body: string;
    message: string;
    label: { name: string; description: string } | null;
    files: readonly { path: string; content: string | null }[];
    pull?: number;
  }) => Promise<Answered<{ number: number; url: string }>>;
  /** The open pull requests from this repo's own branches whose name starts with `prefix`. */
  open: (
    repo: Repo,
    prefix: string,
  ) => Promise<Tracked<{ branch: string; number: number; url: string }[]>>;
};

/** A box's EC2 instance state, as EC2 names it. */
export const BOX_STATES = [
  'pending',
  'running',
  'stopping',
  'stopped',
  'shutting-down',
  'terminated',
] as const;
export type BoxState = (typeof BOX_STATES)[number];

/**
 * One box (ADR 0021: one Workspace, one box): an EC2 instance made from the box launch template,
 * it, its volume and its role tagged `abe:owner` (the owner's GitHub login) and `abe:box` (its
 * name).
 */
export type Box = {
  /** Its EC2 instance id (`i-…`). */
  id: string;
  /** Its `abe:box` tag: the repo's box name (`boxName`), unique among its owner's boxes. */
  name: string;
  /** Its `abe:owner` tag: the owner's GitHub login. */
  owner: string;
  state: BoxState;
  /** Its instance type (`m8g.large`). */
  size: string;
  /** Its availability zone (`eu-west-1a`): where an EC2 Instance Connect Endpoint reaches it. */
  zone: string;
  /** Its private IPv4 address; null while it has none. */
  privateIp: string | null;
  /** Its VPC and subnet: the EC2 Instance Connect Endpoint that reaches it is the VPC's. */
  vpc: string | null;
  subnet: string | null;
  /** The repo its workspaces work in (`abe:repo` tag); null for a box without one. */
  repo: string | null;
  /**
   * An old box's one card (`abe:card` tag: a 2.2 box made for one card, never launched on,
   * ADR 0022); null for a repo's box.
   */
  card: number | null;
  /** An old box's card's title (`abe:title` tag); none or null: not said. */
  title?: string | null;
  /** EC2's `LaunchTime` (ISO): when it was made or last started; none or null: not said. */
  launchedAt?: string | null;
  /**
   * The box launch template version it was made from (EC2's `aws:ec2launchtemplate:version`
   * tag, #104); none or null: not made from it.
   */
  release?: number | null;
};

/** What `Boxes.up` makes a box for when the card has none: its tags and its first size. */
export type BoxSpec = {
  /** The name its placement chose (`boxName`): the repo's, unique among its owner's boxes. */
  name: string;
  /** `<owner>/<repo>` its workspaces work in (ADR 0022: one box per repo). */
  repo: string;
  /** Its instance type when it is made (`box.size`; default: the launch template's). */
  size?: string;
  /**
   * The AWS profile it is made on: `box.profile` in force where it was launched (ADR 0025);
   * none or null: serve's own.
   */
  profile?: string | null;
};

/**
 * The person's boxes on EC2 (ADR 0021), as the person: the AWS CLI on their own SSO profile on
 * the Mac. Only boxes tagged `abe:owner` with their own login are theirs: `list` and `status`
 * show no others, and IAM refuses any other's start, stop or change (ABAC). Every call answers at
 * once with what EC2 said (nothing waits for a state); its data or why not (`aws-auth`: the SSO
 * login expired; `aws-refused`: IAM said no; `aws-failed`; `no-box`; `box-busy`); none throws.
 * Attaching and forwarding a port to a box (SSH through its EC2 Instance Connect Endpoint) are
 * `BoxLink`'s, not this.
 */
export type Boxes = {
  /** The person's boxes, every one not terminated, by name. */
  list: () => Promise<Answered<Box[]>>;
  /** One of the person's boxes by name (EC2 read again); null when they have none by it. */
  status: (name: string) => Promise<Answered<Box | null>>;
  /**
   * The card's box on its way up: made from the box launch template (tagged from `spec`, its
   * role the owner's) when the person has none by `spec.name`, started when it is stopped,
   * answered as it is when it is pending or running. `box-busy` while it is stopping or
   * going away.
   */
  up: (spec: BoxSpec) => Promise<Answered<Box>>;
  /**
   * One of the person's boxes started (a wake, a resize's restart): never made, so `no-box` when
   * it is gone; answered as it is when it is pending or running, `box-busy` while stopping.
   */
  start: (name: string) => Promise<Answered<Box>>;
  /** A box stopped, its disk kept (asked: it is `stopping` in the answer). Stopped already is fine. */
  stop: (name: string) => Promise<Answered<Box>>;
  /** A stopped box's instance type changed to `size` (`box-busy` unless it is stopped). */
  resize: (name: string, size: string) => Promise<Answered<Box>>;
  /**
   * A box deleted, its disk with it (EC2 TerminateInstances as the person; it is
   * `shutting-down` in the answer). IAM may refuse it (ABAC: only a lead terminates):
   * `terminate-refused`.
   */
  terminate: (name: string) => Promise<Answered<Box>>;
};

/**
 * Download locally and Move to cloud's copy (#88, `ports/src/git/move.ts`): a worktree read and
 * written where it is. `exec` goes before each command: nothing on this Mac, `abe box attach <box>
 * --` for a Workspace on its box (ADR 0021). The pack is one file on this Mac.
 */
export type Mover = {
  /** Whether `exec` answers at all (a box's attach wakes it first); `box-unreachable` if not. */
  reach: (exec: readonly string[]) => Promise<Answered<null>>;
  /**
   * The worktree at `root` against commit `from` as one patch, its untracked files too (a
   * prototype on a box: what make-card keeps of it).
   */
  diff: (exec: readonly string[], root: string, from: string) => Promise<Answered<string>>;
  /**
   * The worktree's head, its real path (`cwd`: as its claude's transcript names it), whether it
   * has staged and unstaged changes, its untracked and `.scratch/` files.
   */
  list: (
    exec: readonly string[],
    root: string,
  ) => Promise<
    Answered<{ head: string; cwd: string; staged: boolean; unstaged: boolean; files: string[] }>
  >;
  /** The commits to its head, both diffs, `files` and the transcript (null: none) packed into `out`. */
  pack: (o: {
    exec: readonly string[];
    root: string;
    files: readonly string[];
    transcript: string | null;
    out: string;
  }) => Promise<Answered<null>>;
  /**
   * `pack` into the worktree at `root`: changes there stashed first (`stash` its message), the
   * branch at the moved head (refused, `branch-diverged`, when a branch of that name there has
   * commits the head has not), the diffs, of the pack's files only `files` (the plan's, by
   * name: nothing else it holds lands), the transcript at `log` (relative to `root`).
   */
  unpack: (o: {
    exec: readonly string[];
    root: string;
    pack: string;
    files: readonly string[];
    branch: string;
    log: string | null;
    stash: string;
  }) => Promise<Answered<null>>;
  /**
   * The local folder `from` copied whole to `dir` (relative, inside it) in the worktree at `root`,
   * what was there replaced: a cloud run's prototype reference into its clone (#351).
   */
  put: (o: {
    exec: readonly string[];
    root: string;
    dir: string;
    from: string;
  }) => Promise<Answered<null>>;
  /**
   * `put` the other way: the folder `dir` (relative) of the worktree at `root` copied whole into
   * the local folder `to` (made when missing); none there copies nothing (a box prototype's PNGs).
   */
  get: (o: {
    exec: readonly string[];
    root: string;
    dir: string;
    to: string;
  }) => Promise<Answered<null>>;
  /** A new worktree for `branch` at Abe's place beside `repo`'s main checkout, detached for now. */
  worktree: (repo: string, branch: string) => Promise<Answered<string>>;
  /** The worktree `path` of `repo` taken away again (a move that failed after making it). */
  dropWorktree: (repo: string, path: string) => Promise<Answered<null>>;
};

/**
 * Box parity's IO on the Mac (3.2.1, `box-sync.ts`): Claude Code's own credential store read
 * (never said), and a sync sent into a card's workspace on stdin.
 */
export type BoxSyncPort = {
  /**
   * Claude Code's credential store on this Mac, parsed: the Keychain item it keeps (`Claude
   * Code-credentials`), else `~/.claude/.credentials.json`; undefined when neither is readable.
   * Its values are the sources' tokens: never logged, said or written anywhere but a sync.
   */
  claudeStore: () => Promise<unknown>;
  /**
   * `payload` (`boxSyncPayload`) into the workspace `exec` reaches (`inWorkspace`), on stdin to
   * `BOX_SYNC_SCRIPT`; never in an argv. What fails is said by its exit, never by its output.
   */
  push: (exec: readonly string[], payload: string) => Promise<Answered<null>>;
};

/**
 * The PR review's outside world: git in the PR's checkout, GitHub as the person (`gh`), and the
 * drafts and marks docs in the main checkout's `.scratch/abe` (1.x's files, so a review started
 * before carries on). IO only; the rules are `review/`'s.
 */
/**
 * What a failed call means: `auth`, `not-found`, `conflict` (409, a moved head), `invalid` (422),
 * `refused` (403), `offline`, `precondition` (the checkout changed under it), else `failed`.
 */
export const REVIEW_ERRORS = [
  'auth',
  'not-found',
  'conflict',
  'invalid',
  'refused',
  'offline',
  'precondition',
  'failed',
] as const;
export type ReviewErrorCode = (typeof REVIEW_ERRORS)[number];
export type ReviewError = { code: ReviewErrorCode; message: string };
export type ReviewAnswer<T> = { ok: true; data: T } | { ok: false; error: ReviewError };

/** A worktree of the main checkout, with the branch it is on (null: detached). */
export type ReviewWorktree = { path: string; branch: string | null };

/** What a Draft PR is made from, read without writing anything. */
export type DraftPrPlan = {
  root: string;
  repo: string;
  branch: string;
  head: string;
  /** The base the dialog starts on: the default branch. */
  base: string;
  origin: string;
  title: string;
  /** The description it starts with: the card the branch names, then the commits' subjects. */
  body: string;
  /** The branch's commits and files not on the base (as last fetched; 0 when unknown). */
  commits: number;
  files: number;
  /** Local changes not committed: not part of the PR. */
  uncommitted: string[];
  /** The branch's head is on origin already. */
  published: boolean;
  /** The PR open on the branch already, reused. */
  existing: { number: number; url: string } | null;
  /** The bases to pick from: the default branch first, then origin's other branches. */
  branches: string[];
  /** Who can be asked to review: the repo's assignable people, you left out. */
  reviewers: { login: string; name: string }[];
};

export type ReviewPort = {
  // ---- git, in a checkout ----
  /** The main checkout `path` belongs to (itself when it is one). */
  mainOf: (path: string) => Promise<ReviewAnswer<string>>;
  /** origin's GitHub repo (`owner/name`); null when origin is not on GitHub. */
  repoOf: (path: string) => Promise<ReviewAnswer<string | null>>;
  /** The checkout's files against the merge base with `base` (`origin/<branch>`), with patches. */
  changes: (path: string, base: string) => Promise<ReviewAnswer<Changes>>;
  /** The commits of `from..to`, oldest first, each with its files' patches. */
  commits: (path: string, from: string, to: string) => Promise<ReviewAnswer<RangeCommit[]>>;
  /** The checkout's folders holding a `package.json`. */
  packages: (path: string) => Promise<ReviewAnswer<string[]>>;
  /** The main checkout's worktrees. */
  worktrees: (main: string) => Promise<ReviewAnswer<ReviewWorktree[]>>;
  /**
   * PR `number`'s head (`refs/pull/<n>/head`, or `branch` from origin) in the worktree at `path`:
   * one there is brought up to it when that fast-forwards; else made, on `branch` (a new local
   * branch from the PR's head). Answers where it stands. With `upstream`, `branch` tracks the PR's
   * head branch as gh's checkout does (origin's `<ref>`; a fork's by its URL), so a push from it
   * reaches the pull request.
   */
  checkoutPr: (input: {
    main: string;
    path: string;
    number: number;
    branch: string;
    base: string;
    reuse: boolean;
    upstream?: { ref: string; fork?: { owner: string; repo: string } | undefined } | undefined;
  }) => Promise<ReviewAnswer<{ path: string; head: string }>>;

  // ---- GitHub, as the person ----
  me: () => Promise<ReviewAnswer<string>>;
  pr: (repo: string, number: number) => Promise<ReviewAnswer<ReviewPr>>;
  prs: (repo: string) => Promise<ReviewAnswer<OpenPr[]>>;
  /** GitHub's list of the PR's files with their patches: when it is not checked out. */
  prFiles: (repo: string, number: number) => Promise<ReviewAnswer<ChangedFile[]>>;
  threads: (repo: string, number: number) => Promise<ReviewAnswer<Thread[]>>;
  /**
   * One review on its commit, marked with its submission; a retry (`reconcileOnly`) only looks
   * for it, and a lost answer is read back before it counts as failed.
   */
  submit: (repo: string, review: ReviewOut) => Promise<ReviewAnswer<null>>;
  /** One inline comment posted now, marked and read back as a review is. */
  postComment: (input: {
    repo: string;
    number: number;
    head: string;
    submission: string;
    reconcileOnly: boolean;
    comment: ReviewComment;
  }) => Promise<ReviewAnswer<null>>;
  /** A reply under a discussion's first comment, marked and read back. */
  reply: (input: {
    repo: string;
    number: number;
    commentId: number;
    submission: string;
    reconcileOnly: boolean;
    body: string;
  }) => Promise<ReviewAnswer<null>>;
  resolve: (thread: string, resolved: boolean) => Promise<ReviewAnswer<null>>;
  /** Out of draft. */
  ready: (repo: string, number: number) => Promise<ReviewAnswer<null>>;
  /** Closed without merging. */
  close: (repo: string, number: number) => Promise<ReviewAnswer<null>>;
  /** A comment on the PR's conversation. */
  say: (repo: string, number: number, body: string) => Promise<ReviewAnswer<null>>;

  // ---- Draft PR ----
  draftPlan: (root: string) => Promise<ReviewAnswer<DraftPrPlan>>;
  /**
   * The draft PR made from `plan` (refused when the branch, its head or origin moved since): its
   * head pushed first when `push` and not published; an open PR on the branch is reused.
   */
  draftCreate: (input: {
    plan: DraftPrPlan;
    title: string;
    body: string;
    base: string;
    push: boolean;
  }) => Promise<ReviewAnswer<{ number: number; url: string }>>;
  /** Asks `logins` to review PR `number`. */
  requestReviewers: (
    repo: string,
    number: number,
    logins: readonly string[],
  ) => Promise<ReviewAnswer<null>>;

  // ---- the docs, in the main checkout's `.scratch/abe` ----
  marks: (main: string, pr: number) => Promise<ReviewAnswer<Marks | null>>;
  putMarks: (main: string, pr: number, marks: Marks) => Promise<ReviewAnswer<null>>;
  drafts: (main: string, pr: number) => Promise<ReviewAnswer<Drafts>>;
  putDrafts: (main: string, pr: number, drafts: Drafts) => Promise<ReviewAnswer<null>>;
};

/**
 * Factory install's local reads (#22): the checkout, its files, git's ignores, and whether the
 * app's URL answers. Read never goes past these: nothing remote is touched before Logins.
 */
export type InstallRepo = {
  /**
   * `dir`'s checkout: its top folder and whether it is the main checkout (no worktree), and the
   * main checkout's top (git's common dir's; a card worktree's too); none: not one.
   */
  checkout: (
    dir: string,
  ) => Promise<{ top: string; main: boolean; mainTop?: string | undefined } | undefined>;
  /** A file's text under `top` (`path` relative); `undefined` when it is not there. */
  read: (top: string, path: string) => Promise<string | undefined>;
  /** The file names in a folder under `top`; empty when it is not there. */
  list: (top: string, dir: string) => Promise<string[]>;
  /**
   * The lines of the files git tracks in `top` matching `pattern` (extended, any case; `git grep`),
   * at most `max`: each one's path, line number and text.
   */
  grep: (
    top: string,
    pattern: string,
    max: number,
  ) => Promise<{ path: string; line: number; text: string }[]>;
  /** Whether git ignores `path` in `top`. */
  ignored: (top: string, path: string) => Promise<boolean>;
  /** The folder `dir` under `top` taken away when it is empty; whether it was. A full one stays. */
  removeEmpty: (top: string, dir: string) => Promise<boolean>;
  /** Whether `url` answers at all (any HTTP status) within a few seconds. */
  answers: (url: string) => Promise<boolean>;
  /** The checkout's `origin` remote URL; undefined: none. Never said: it may carry a login. */
  origin: (top: string) => Promise<string | undefined>;
  /** Whether git tracks `path` in `top`. */
  tracked: (top: string, path: string) => Promise<boolean>;
  /**
   * The branch of origin's default (`origin/main`, as fetched last: nothing remote is asked) when
   * it tracks the folder `path` and `top`'s HEAD does not track the same there (none, or another);
   * undefined: it tracks none there, the same, or there is no origin branch known.
   */
  originOnly: (top: string, path: string) => Promise<string | undefined>;
  /**
   * Each of `commands` run once, in order, on a clean tree of HEAD made outside the checkout (its
   * working tree and untracked files untouched, none of the person's environment): whether it
   * passed and the tail of what it said. `undefined`: there is no HEAD to make a tree from.
   */
  runChecks: (top: string, commands: readonly string[]) => Promise<readonly CheckRun[] | undefined>;
  /**
   * One check's command in the main checkout `top` itself, as serve (outside every session's
   * sandbox): serve's allowlisted environment (`checksEnv`, `CI=true`) with `env` over it, killed
   * after `timeoutMs`. What it printed comes back whole: the caller redacts it.
   */
  runCheck: (
    top: string,
    o: { run: string; env: Readonly<Record<string, string>>; timeoutMs: number },
  ) => Promise<ShellRan>;
  /** The paths git tracks in `top` that differ from HEAD, staged or not (a typechange too). */
  changed: (top: string) => Promise<string[]>;
  /**
   * A throwaway worktree of `top`'s HEAD made outside the checkout, made ready by the repo's
   * worktree recipe as a Before worktree is (`copy`'s files, packages linked, `run` last, no
   * install), then removed: what it did, and the recipe's paths (`listed`, not skipped) it still
   * lacked after. Refused when no worktree could be made.
   */
  tryWorktree?: (
    top: string,
    o: { copy: readonly WorktreeCopy[]; run: string | null },
  ) => Promise<Answered<{ ran: SetupRan; absent: string[] }>>;
  /**
   * Just this Mac: `paths` kept out of git in the checkout's `.git/info/exclude` (`on`), or that
   * block taken out again (Connected later). Answers the paths now excluded.
   */
  exclude: (top: string, paths: readonly string[], on: boolean) => Promise<string[]>;
  /**
   * The account `aws sts get-caller-identity --profile <profile>` answers, read only: its id,
   * nothing else (never a key). Any profile name; the cloud check asks an abe-* one alone.
   */
  awsAccount: (profile: string) => Promise<AwsAccount>;
  /** This Mac's aws profiles, as `aws configure list-profiles` names them: names only. */
  awsProfiles: () => Promise<string[]>;
  /** A source's MCP server as Claude Code answers for the person in `top` (`claude mcp get`). */
  mcp: (top: string, name: string) => Promise<McpState>;
  /**
   * The MCP servers a session in `top` loads by name (ADR 0027): the main checkout's Claude Code
   * local scope, then the person's user scope (`~/.claude.json`, names only), never a repo's
   * `.mcp.json`.
   */
  ownMcpServers: (top: string) => Promise<string[]>;
  /**
   * The MCP servers the person's Claude Code has for the main checkout `top` (ADR 0031): its local
   * scope's, then the user scope's, each with its definition, for `abe install sources` to offer
   * and `abe install source <name>` to copy into `sources:`. Abe's own and github never.
   */
  mcpFound: (top: string) => Promise<FoundServer[]>;
  /**
   * A source's server added to the main checkout `top`'s Claude Code local scope
   * (`claude mcp add --scope local --transport <t> <name> <url>`, run there), never a tracked
   * file; why not when it fails. Never `claude mcp remove`: that deletes the shared sign-in.
   */
  addMcp: (
    top: string,
    server: { name: string; transport: 'http' | 'sse'; url: string },
  ) => Promise<{ ok: true } | { ok: false; why: string }>;
  /**
   * A connected source's probe (ADR 0027): one reading tool call through the person's own
   * `claude -p` as `model` (core's `sourceAccountArgv`), on a generated config of that one server
   * as a session in `top` gets it: whether it returned without error, and only the names it told.
   */
  sourceAccount: (top: string, name: string, model: string) => Promise<SourceProbe>;
  /**
   * The source `name`'s sign-in, in the person's own browser, through Claude Code's MCP OAuth
   * (core's `source-sign-in.ts`): the server as a session in `top` gets it. The token never
   * passes through Abe. `fallback`: Claude Code has no headless sign-in, the person updates it.
   */
  signInMcp: (top: string, name: string) => Promise<SignInResult>;
  /**
   * An aws profile's short-lived keys for the app and the checks (`aws configure
   * export-credentials`, core's `awsSessionEnv`) and its region (`awsRegionEnv`), never the aws
   * folder; why not (an expired login).
   */
  awsCredentials: (
    profile: string,
  ) => Promise<{ ok: true; env: Record<string, string> } | { ok: false; why: string }>;
};

/** Where serve keeps each checkout's install record (`<state>/installs/<id>/install.json`). */
export type InstallStore = {
  read: (repo: string) => Promise<unknown>;
  write: (repo: string, doc: unknown) => Promise<void>;
  /**
   * The record moved aside into a folder of its own beside it, named by `at`
   * (`aside.<at>/install.json`), with each of `also` (folders in the checkout, absolute) moved in
   * beside it by name: where each went; undefined when there is no record.
   */
  aside: (
    repo: string,
    at: string,
    also?: readonly string[],
  ) => Promise<{ record: string; also: string[] } | undefined>;
  /**
   * The record kept for `from` (its folder, the records moved aside with it) kept for `to`, a repo
   * moved: whether it went (none for `from`, or one for `to` already: it stays).
   */
  move: (from: string, to: string) => Promise<boolean>;
};

/** A `DemoShop` step's answer: its data, or what went wrong in the tool's own words. */
export type DemoDone<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * `abe demo new`'s world: the demo bundled with this abe, your folders, git, and GitHub through
 * `gh` on its own login. Never throws.
 */
export type DemoShop = {
  /** Your home folder, where `~` and the default folder are. */
  home: string;
  /** The bundled demo's folder (its checkout's `examples/demo-shop` or the app bundle's); null: none. */
  source: () => string | null;
  /** Whether anything is at `path`. */
  exists: (path: string) => boolean;
  /** A file of the bundled demo, as text (`board/seed.json`). */
  read: (source: string, file: string) => DemoDone<string>;
  /** gh's signed-in login. */
  login: () => Promise<DemoDone<string>>;
  /** Whether `repo` (`<owner>/<name>`) is on GitHub. */
  repoExists: (repo: string) => Promise<DemoDone<boolean>>;
  /**
   * The demo copied from `source` to the new `folder` (`skip`: names left out wherever they are), made a git
   * repo on `main` with one commit; `author` signs it when git has no identity of yours.
   */
  copy: (o: {
    source: string;
    folder: string;
    skip: readonly string[];
    author: { name: string; email: string };
  }) => Promise<DemoDone<void>>;
  /** `repo` created private on GitHub from `folder`, as its `origin`, and `main` pushed: its URL. */
  publish: (folder: string, repo: string) => Promise<DemoDone<string>>;
  /** A card made an issue in `repo`, assigned to `assignee` (your login: Launch agent takes it). */
  issue: (repo: string, card: DemoCard, assignee: string) => Promise<DemoDone<DemoIssue>>;
};
