/**
 * Claude Code sessions (spec #37, ADR 0020): where a session stands, read from Claude Code's hooks
 * only (never from its transcript, never from the screen), the card's branch and launch prompt,
 * the clean environment a session starts with, the hook settings that register `abe hook` for
 * every event, and the results `abe session` prints.
 */
import { z } from 'zod';
import { LaunchProgress } from '../box/launch';
import { AskCard } from './ask';
import { type ModelPicker, sessionModelPicker } from './model-pick';
import { readOverrides } from '../layer/override';
import { RepoHere } from '../board/here';
import { type BoardRef, boardCardName, isGithubBoard, isLocalBoard } from '../board/board';
import { HookAnswer } from './permission';
import { EFFORTS, isWriteName, type SessionMcp, REPO_PATH } from '../layer/settings';
import { SetupRan, setupText } from './setup';
import { LaunchNote, notesPrompt, noteLines, StandingNote } from '../factory/launch-note';
import { FACTORY_SKILL } from '../skills/skills';
import {
  AGENT_HOOK_FIELDS,
  AgentCall,
  PLUGIN_NAME,
  SessionModels,
  SubagentRun,
  subagentText,
} from '../skills/subagents';
import { localWhen, type TextAt } from '../command';
import { ABE_ENV_GLOB } from '../install/credentials';
import { queuedForText } from '../box/box-text';
import { modelName } from './model-name';
import { WAITING_ON, type WaitingOn } from './waits-on';

/**
 * Working, waiting (`waitingOn`: idle at your turn, or on you), or ended; before its first hook a session is starting (its `claude`
 * coming up, #190; in your environment its box too) or, there, queued (at the team's box limit).
 * Ended stays ended.
 */
export const SESSION_STATES = ['queued', 'starting', 'working', 'waiting', 'ended'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * The hook events `abe hook` is registered for: every event Claude Code 2.1 has but
 * `WorktreeCreate` / `WorktreeRemove`, whose command hooks replace git's worktree creation (the
 * hook's stdout is the worktree's path), so registering them would break a writer's worktree.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'Elicitation',
  'ElicitationResult',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/**
 * What a hook's JSON on stdin carries that Abe reads (Claude Code's common fields and the few
 * event fields the state needs); the rest is kept as it came, in `hooks.jsonl`.
 */
export const HookPayload = z.looseObject({
  // the subagents' fields (`subagentsAfter`), the strict ones below over theirs
  ...AGENT_HOOK_FIELDS,
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  /** Notification: `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `auth_success` … */
  notification_type: z.string().optional(),
  /** SessionEnd: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`. */
  reason: z.string().optional(),
  /** PreCompact / PostCompact: `manual` (`/compact`, typed while idle) or `auto`. */
  trigger: z.string().optional(),
  /** Stop and StopFailure: the main agent's last message, so the transcript is never parsed. */
  last_assistant_message: z.string().optional(),
  /** PermissionRequest (and the tool events): the tool the prompt is for. */
  tool_name: z.string().optional(),
  /** A subagent's hook: its id; absent for the session's own agent. */
  agent_id: z.string().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

/**
 * The cause of a session's move to waiting when its own agent was stopped mid-turn (Esc in its
 * Claude Code): no hook comes then, its transcript's line says so. Its run is at Needs you.
 */
export const INTERRUPTED = 'interrupted';
/** Why a run is at Needs you after its session was interrupted. */
export const INTERRUPTED_REASON =
  'its turn was interrupted (Esc): Claude Code waits for what to do instead';

/** How long a launched `claude` has to run its first hook before Abe gives up on it. */
export const SESSION_START_TIMEOUT_MS = 60_000;

/**
 * Claude Code's MCP server start timeout (`MCP_TIMEOUT`, ms) in every session's `claude`: a
 * stalling source's server gives up well inside `SESSION_START_TIMEOUT_MS`, never holding the
 * session's start (its first hook) on it.
 */
export const MCP_START_TIMEOUT_ENV = 'MCP_TIMEOUT';
export const MCP_START_TIMEOUT_MS = 15_000;

/** Why Abe ended a session whose `claude` never ran a hook (a settings error, an old `claude`). */
const NO_HOOK = `its claude did not start: no SessionStart hook within ${SESSION_START_TIMEOUT_MS / 1000} s`;

export const NO_START = `${NO_HOOK} (an error or a dialog before Claude Code's hooks run)`;

/** The most a no-start reason runs to: a card's line, not the whole screen. */
export const NO_START_MAX = 400;

// eslint-disable-next-line no-control-regex -- terminal colours and cursor moves in a captured screen
const SCREEN_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]/g;

/** Box and tree drawing, a dialog's frame and its pointer: none of it is words. */
const FRAME = /^[\s\u2500-\u257f\u2190-\u21ff❯›>·•]+|[\s\u2500-\u257f]+$/g;

/**
 * Why Abe ended a session whose `claude` ran no hook (#190): `NO_START`, and when its terminal
 * was read first, what it stopped at (a Settings Error dialog's lines, Claude Code's own error),
 * one line, cut at `NO_START_MAX`.
 */
export const noStartReason = (screen: string | undefined): string => {
  const lines = (screen ?? '')
    .replace(SCREEN_ESCAPES, '')
    .split('\n')
    .map((l) => l.replace(FRAME, '').replace(/\s+/g, ' '))
    .filter((l) => l !== '');

  if (lines.length === 0) return NO_START;
  const reason = `${NO_HOOK}; it stopped at: ${lines.join(' · ')}`;

  return reason.length > NO_START_MAX ? `${reason.slice(0, NO_START_MAX - 1)}…` : reason;
};

/** When a `claude` launched at `ms` must have run its first hook by (RFC 3339). */
export const startBy = (ms: number): string =>
  new Date(ms + SESSION_START_TIMEOUT_MS).toISOString();

/** Whether a session is past its start timeout with no hook heard (`startBy` is cleared by one). */
export const startOverdue = (
  meta: { state: SessionState; startBy: string | null },
  now: number,
): boolean => meta.state !== 'ended' && meta.startBy !== null && now >= Date.parse(meta.startBy);

/**
 * Why a launch on a card is refused while it has a session open (#187), with the way on: attach
 * it, or stop it first.
 */
export const cardHasSession = (card: number | string, session: string, repo: string): string =>
  `AB#${card} already has session ${session} in ${repo}: attach it (abe session attach ${session}) or stop it first (abe session stop ${session})`;

/** The socket file a session's own `serve` socket is named: commands on it act on that session. */
export const SESSION_SOCKET = 'session.sock';

/** Whether a socket path is a session's: a client there never starts a `serve` of its own. */
export const isSessionSocket = (path: string): boolean => path.endsWith(`/${SESSION_SOCKET}`);

/**
 * Where a card's worktree goes: beside the main checkout, `<repo>-wt/<id>-<slug>` (the
 * `vimstorm-wt/` way), so a worktree never nests inside another; a developer's prototype's
 * (`proto/<id>-<slug>`, #83) as `<repo>-wt/proto-<id>-<slug>`.
 */
export const worktreePath = (mainCheckout: string, branch: string): string => {
  const cut = mainCheckout.replace(/\/+$/, '');
  const slash = cut.lastIndexOf('/');

  return `${cut.slice(0, slash)}/${cut.slice(slash + 1)}-wt/${branch.replace(/^card\//, '').replace(/^proto\//, 'proto-')}`;
};

/**
 * Where Before's worktree goes: beside the card's own (`<repo>-wt/<id>-<slug>-base`), at the merge
 * base of the card's branch and the default branch, detached.
 */
export const baseWorktreePath = (mainCheckout: string, branch: string): string =>
  `${worktreePath(mainCheckout, branch)}-base`;

/**
 * The default branch, first found: the remote's own `HEAD`, then `main` or `master` locally, then
 * the remote's.
 */
export const DEFAULT_BRANCH_REFS = [
  'refs/remotes/origin/HEAD',
  'refs/heads/main',
  'refs/heads/master',
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
] as const;

/**
 * Where a card's new branch starts (#198): the default branch on origin as just fetched, first
 * found; without one the checkout's own default branch, then its `HEAD`.
 */
export const BRANCH_BASE_REFS = [
  'refs/remotes/origin/HEAD',
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
] as const;

/**
 * Where a card's branch was made from at launch (#198): `from` the ref (`origin/main`), `commit`
 * its head then, `note` why it is not origin's default branch as fetched now (origin not reached,
 * no origin); null when it is.
 */
export const BranchBase = z.object({
  from: z.string(),
  commit: z.string(),
  note: z.string().nullable(),
});
export type BranchBase = z.infer<typeof BranchBase>;

/** `origin/main at 1a2b3c4, fetched at launch`, or the ref with its note. */
export const branchBaseText = (b: BranchBase): string =>
  `${b.from} at ${b.commit.slice(0, 7)}${b.note === null ? ', fetched at launch' : `: ${b.note}`}`;

/** The person's words a launch prompt carries after the card (#347). */
export type PromptNotes = {
  note?: LaunchNote | null | undefined;
  standing?: readonly StandingNote[] | undefined;
};

/**
 * What a session on a card of a board on this machine is told of its name: GitHub links `AB#<n>`
 * to Azure Boards' card n, someone else's.
 */
export const onThisMachineLine = (id: number): string =>
  `This card is on this machine's board: name it ${boardCardName(id, { provider: 'local' })} in commits, the pull request and comments, never AB#${id}, which GitHub links to Azure Boards' card ${id}.`;

/** What a session on a GitHub board's card is told of its name: the issue's own. */
export const githubIssueLine = (id: number): string =>
  `This card is the repo's GitHub issue #${id}: name it #${id} in commits, the pull request and comments, never AB#${id}, which GitHub links to Azure Boards' card ${id}.`;

/**
 * The core launch prompt: the card's name and title (`board`: the board it is on, Azure Boards
 * when none), description and criteria, its comments oldest first (the whole card: an answer may
 * be in them), then the person's Launch note and the standing notes in force (#347).
 */
export const launchPrompt = (
  card: {
    id: number;
    title: string;
    description: string;
    acceptanceCriteria: string;
    comments?: readonly { by: string; at: string; text: string }[] | undefined;
    board?: Pick<BoardRef, 'provider'> | undefined;
  },
  o: PromptNotes = {},
): string => {
  const comments = (card.comments ?? []).filter((c) => c.text.trim() !== '');
  const description = card.description.trim();
  const criteria = card.acceptanceCriteria.trim();
  const notes = notesPrompt(o.note, o.standing);
  const board = card.board ?? {};

  return [
    `Work on card ${boardCardName(card.id, board)}: ${card.title}`,
    ...(isLocalBoard(board) ? ['', onThisMachineLine(card.id)] : []),
    ...(isGithubBoard(board) ? ['', githubIssueLine(card.id)] : []),
    ...(description === '' ? [] : ['', description]),
    ...(criteria === '' ? [] : ['', '## Acceptance criteria', '', criteria]),
    ...(comments.length === 0
      ? []
      : [
          '',
          '## Comments, oldest first',
          ...comments.flatMap((c) => ['', `${c.by}, ${c.at.slice(0, 10)}:`, c.text.trim()]),
        ]),
    ...(notes === '' ? [] : ['', notes]),
  ].join('\n');
};

/** A run's launch prompt: core's plugin's factory skill, invoked on the card. */
export const factoryLaunchPrompt = (
  card: Parameters<typeof launchPrompt>[0],
  o: PromptNotes = {},
): string => `/${PLUGIN_NAME}:${FACTORY_SKILL} ${launchPrompt(card, o)}`;

export type Env = Readonly<Record<string, string | undefined>>;

/** The locale names a session keeps from `serve`'s environment. */
export const LOCALE = [
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
];

/**
 * A local workspace's database: `serve`'s `DATABASE_URL`, handed to the session and the checks
 * (a box's workspace has its own, ADR 0016). The app's, never a token.
 */
export const WORKSPACE_DATABASE = 'DATABASE_URL';

/** A UTF-8 locale every Mac and Linux box has, when `serve` was given none. */
const DEFAULT_LANG = 'en_US.UTF-8';

/** What a session's terminal is: `tmux`'s panes speak xterm's 256 colours. */
export const SESSION_TERM = 'xterm-256color';

/**
 * A session's whole environment: `HOME`, `USER`, `PATH` (with `abe`'s own folder first), `TERM`,
 * the locale, the person's `SHELL`, `serve`'s `DATABASE_URL` (`WORKSPACE_DATABASE`), its own
 * `ABE_SOCKET` and the Reach names it was given, and nothing else. `USER` is how Claude Code on
 * macOS finds its login in the Keychain (without it: "Not logged in"); `SHELL` the shell its
 * commands are written for (its shell snapshot's), which the jail runs them in (`jailWrapper`).
 * A write name is refused: a local session never gets one.
 */
export const sessionEnv = (o: {
  parent: Env;
  /** Where the session's `abe` is: first on its `PATH`. */
  bin: string;
  socket: string;
  reach: Readonly<Record<string, string>>;
}): { ok: true; env: Record<string, string> } | { ok: false; code: string; message: string } => {
  const writes = Object.keys(o.reach).filter(isWriteName);

  if (writes.length > 0)
    return {
      ok: false,
      code: 'write-name',
      message: `a local session never gets a write name: ${writes.join(', ')}`,
    };
  const foreign = Object.keys(o.reach).filter((name) => !name.startsWith('ABE_'));

  if (foreign.length > 0)
    return { ok: false, code: 'not-reach', message: `not a Reach name: ${foreign.join(', ')}` };
  const locale = Object.fromEntries(
    LOCALE.flatMap((name) => {
      const value = o.parent[name];

      return value === undefined || value === '' ? [] : [[name, value]];
    }),
  );
  const parentPath = o.parent.PATH ?? '';
  const database = o.parent[WORKSPACE_DATABASE];
  const shell = o.parent.SHELL;

  return {
    ok: true,
    env: {
      HOME: o.parent.HOME ?? '/',
      ...(o.parent.USER === undefined || o.parent.USER === '' ? {} : { USER: o.parent.USER }),
      ...(shell?.startsWith('/') === true ? { SHELL: shell } : {}),
      PATH: parentPath === '' ? o.bin : `${o.bin}:${parentPath}`,
      TERM: SESSION_TERM,
      ...(Object.keys(locale).length === 0 ? { LANG: DEFAULT_LANG } : locale),
      ...(database === undefined || database === '' ? {} : { [WORKSPACE_DATABASE]: database }),
      ...o.reach,
      ABE_SOCKET: o.socket,
    },
  };
};

/** A word for `/bin/sh`: single-quoted, so nothing in it is expanded. */
export const shellWord = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * How long Claude Code lets one `abe hook` run; the hook itself gives up after one second,
 * AskUserQuestion's PreToolUse after four (`hooks`' `PERMISSION_DEADLINE_MS`, also a
 * PermissionRequest's stdin read). A PermissionRequest's is `PERMISSION_HOOK_TIMEOUT_S`, a
 * UserPromptSubmit's `TURN_START_HOOK_TIMEOUT_S`.
 */
export const HOOK_TIMEOUT_S = 5;

/**
 * The most serve holds a hook's answer back for its own waits (Chat's transcript read on, a paste
 * on its way in) when the hook gives up after one second (`hooks`' `HOOK_DEADLINE_MS`, from its
 * process's start): half of it, the rest the hook's own start, its stdin and the socket. A wait
 * past it would only lose the answer, never hold Claude Code longer.
 */
export const HOOK_WAIT_MS = 500;

/**
 * How long serve holds a PermissionRequest under a live Override for its permission card (#114):
 * ten minutes, then the hook answers nothing and Claude Code's own dialog stays (the #113 spike
 * held one 610 s).
 */
export const PERMISSION_HOLD_MS = 600_000;

/**
 * Claude Code's timeout for the PermissionRequest hook: past the hold and the hook's own deadline
 * (`hooks`' `PERMISSION_HOLD_DEADLINE_MS`), so a held card is answered before Claude Code gives up.
 */
export const PERMISSION_HOOK_TIMEOUT_S = 630;

/**
 * Claude Code's timeout for the UserPromptSubmit hook (#113): it waits for serve's snapshot of the
 * turn's start (behind the last turn's Stop one, each git's at most five minutes), so Revert sees
 * every write of the turn; past the hook's own deadline (`hooks`' `TURN_START_DEADLINE_MS`).
 */
export const TURN_START_HOOK_TIMEOUT_S = 630;

/**
 * Claude Code's timeout for the PreToolUse hook (#181): a timeout lets the tool go on, so a fenced
 * tool's hook (its own deadline four seconds, then it refuses the tool itself) gets room past a
 * slow start; every other PreToolUse hook still gives up after one second.
 */
export const PRE_TOOL_HOOK_TIMEOUT_S = 15;

const hookTimeout = (event: string): number => {
  if (event === 'PermissionRequest') return PERMISSION_HOOK_TIMEOUT_S;
  if (event === 'PreToolUse') return PRE_TOOL_HOOK_TIMEOUT_S;
  if (event === 'UserPromptSubmit') return TURN_START_HOOK_TIMEOUT_S;

  return HOOK_TIMEOUT_S;
};

/**
 * The hosts a session's shell reaches: the package registries and GitHub, so installs, git over
 * https, `gh` and tests run unattended. Any other host is refused by the sandbox itself
 * (`strictAllowlist`, #181), whatever the permission mode: never asked of the auto classifier.
 */
export const SANDBOX_DOMAINS = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'bun.sh',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

/**
 * The package managers' caches under `HOME` a session's installs write to: their own folders only,
 * never all of `~/.cache` or `~/Library/Caches`, where other tools keep what they run later outside
 * the sandbox (an editor's compiled config) and Abe keeps other chats' folders. `npx`'s and `uvx`'s
 * tool folders are written too: a source's stdio MCP server runs inside the jail and installs there.
 */
export const SANDBOX_CACHES = [
  '.npm/_cacache',
  '.npm/_logs',
  '.bun/install/cache',
  'Library/Caches/Yarn',
  '.yarn/berry/cache',
  'Library/Caches/pnpm',
  'Library/pnpm/store',
  'Library/Caches/pip',
  '.cache/uv',
  'Library/Caches/node-gyp',
  '.npm/_npx',
  '.local/share/uv',
] as const;

/** Claude Code's `sandbox` settings as a session uses them (code.claude.com/docs/en/sandboxing). */
export type SandboxSettings = {
  enabled: true;
  /** No sandbox (a missing dependency): `claude` does not start, rather than run unsandboxed. */
  failIfUnavailable: true;
  /** No `dangerouslyDisableSandbox` retry, and a repo's settings cannot loosen it. */
  allowUnsandboxedCommands: false;
  /** Inside the sandbox a command needs no prompt: the boundary holds whatever it runs. */
  autoAllowBashIfSandboxed: true;
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    /** Writes are open but these (ADR 0029). */
    denyWrite: string[];
  };
  network: {
    /** The one Unix socket under a `denyRead` path the shell may connect to: the session's own. */
    allowUnixSockets: string[];
    /** Dev servers and tests on localhost (`serve` listens on Unix sockets only). */
    allowLocalBinding: true;
    allowedDomains: string[];
    /** A host outside `allowedDomains` refused at once, not asked (in auto mode: of the classifier). */
    strictAllowlist: true;
    /** macOS's XPC services a command may look up: trustd, which Go's TLS (`gh`) verifies with. */
    allowMachLookup: string[];
  };
};

/** A session's boundary: its sandbox, and the permission rules for Claude's own file tools. */
export type SessionBoundary = {
  sandbox: SandboxSettings;
  deny: string[];
  /** Claude's file tools' working folders besides its own: its writers' worktrees. */
  directories: string[];
};

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/**
 * macOS's certificate trust service: Go's `crypto/x509` (so `gh`) verifies a server's certificate
 * through it, and without the lookup every `gh` call fails `x509: OSStatus -26276` (#195).
 */
export const TRUSTD = 'com.apple.trustd.agent';

/**
 * What a person does on GitHub, never an agent (#196): a merge (also auto-merge, and an alias that
 * would run one), a branch written through the API (refs, file contents, a commit on a branch),
 * which no pre-push hook sees, and the repository's branch rules or default branch changed. Reads
 * of refs and contents through `gh api` are refused too (no rule tells a read from a write there):
 * git reads a branch.
 */
export const MERGE_DENY = [
  'Bash(gh pr merge:*)',
  'Bash(gh api *pulls/*/merge*)',
  'Bash(gh api *merges*)',
  'Bash(gh api *mergePullRequest*)',
  'Bash(gh api *AutoMerge*)',
  'Bash(gh api *git/refs*)',
  'Bash(gh api *updateRef*)',
  'Bash(gh api *contents/*)',
  'Bash(gh api *createCommitOnBranch*)',
  'Bash(gh api *mergeBranch*)',
  'Bash(gh alias*)',
  // gh's token handed to another client: curl reaches api.github.com too.
  'Bash(gh auth token*)',
  // The default branch's protection, rulesets or name changed (REST and GraphQL), and a request
  // read from a file (`-F query=@file`, `--input`), whose words no rule here sees.
  'Bash(gh api *protection*)',
  'Bash(gh api *rulesets*)',
  'Bash(gh api *BranchProtection*)',
  'Bash(gh api *default_branch*)',
  'Bash(gh api *=@*)',
  'Bash(gh api *--input*)',
  'Bash(gh repo edit*)',
] as const;

/**
 * What a local session's commands are refused besides the sandbox (#196): `MERGE_DENY`, and its
 * worktree's pre-push hook turned off: git's config given on its command line (`-c`,
 * `--config-env`) or in its environment (`GIT_CONFIG_*`, any key, since a rule matches case
 * exactly and git's keys ignore it), `core.hooksPath` named, `--no-verify` however short (git
 * takes any unique start of an option). A raw `git push` to the default branch is the hook's
 * (`session-hooks.ts`); one to `main` / `master` named on the line is refused here too (from the
 * main checkout, whose own hooks let it through). Defence in depth, no wall: a script, or a clone
 * of the remote, may still push.
 */
export const SESSION_COMMAND_DENY = [
  ...MERGE_DENY,
  'Bash(git -c *)',
  // After `-C <dir>` and the like; a `-c` after the command's name is its own (`git grep -c`).
  'Bash(git * -c *=*)',
  'Bash(git *--config-env*)',
  'Bash(*GIT_CONFIG*)',
  'Bash(git *hooksPath*)',
  'Bash(git *hookspath*)',
  'Bash(git *--no-v*)',
  // A push to main or master named on its line: from the main checkout too, whose own hooks let it
  // through (the default branch by any other name only the session hooks know). `git push` or
  // after `-C <dir>`, so a commit message saying "push to main" is no push.
  ...['git push', 'git -C * push'].flatMap((push) =>
    ['main', 'master'].flatMap((branch) => [
      `Bash(${push}* ${branch})`,
      `Bash(${push}* ${branch} *)`,
      `Bash(${push}*:${branch})`,
      `Bash(${push}*:${branch} *)`,
      `Bash(${push}*:refs/heads/${branch}*)`,
    ]),
  ),
] as const;

/**
 * The person's files a write would run as them later (`~` relative): a backstop Edit rule should
 * a fenced tool's hook never answer (Claude Code's timeout lets the tool go on).
 */
const HOME_BACKSTOP = [
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.gitconfig',
  '.config/git/**',
  '.ssh/**',
  'Library/LaunchAgents/**',
] as const;

/**
 * Claude Code's project settings in a worktree: the agent writes neither, so it adds no hook,
 * allow rule or sandbox opening for itself (or the next session there).
 */
export const PROJECT_SETTINGS_DENY = [
  'Edit(**/.claude/settings.json)',
  'Edit(**/.claude/settings.local.json)',
] as const;

/** A local session's own temp folder, under `base` (the Mac's temp folder, real). */
export const sessionTmp = (base: string, id: string): string =>
  `${base.replace(/\/+$/, '')}/abe-sessions/${id}`;

/** The names a session's own temp folder goes by: `TMPDIR`, and `TMP` / `TEMP` turbo passes on. */
export const TMP_NAMES = ['TMPDIR', 'TMP', 'TEMP'] as const;

/** `path` as a Read / Edit rule's absolute path (`//` + the path without its leading slash). */
const rulePath = (path: string) => `/${path}`;

/**
 * What of a tree a session works in Claude's file tools never write (#181): its `.git` (the
 * repository git runs in), and Claude Code's own config at any depth: `.claude` (settings, hook
 * scripts, and skills, agents and commands) and `.mcp.json`. As Edit rules; its shell writes them
 * (ADR 0029: only environment access is held).
 */
const treeHeld = (tree: string): string[] => [
  `Edit(${rulePath(`${tree}/.git`)})`,
  `Edit(${rulePath(`${tree}/**/.claude`)}/**)`,
  `Edit(${rulePath(`${tree}/**/.mcp.json`)})`,
];

/**
 * The files that decide what a session reaches (ADR 0029, 0030), never written by it, so no agent
 * turns an environment on for itself: the repo's settings in the main checkout, your own there
 * (`agents.*`, `.abe/settings.local.yaml`) and in each tree it works in, and the Abe env files of
 * each (`ABE_ENV_GLOB`). The Abe chat has no boundary: it runs unjailed.
 */
const envReachFiles = (o: {
  checkout: string;
  /** The trees besides the checkout: its worktree, Before's, its writers' (a glob). */
  trees: readonly string[];
}): string[] => [
  `${o.checkout}/${REPO_PATH}`,
  ...[o.checkout, ...o.trees].flatMap((t) => [
    `${t}/.abe/settings.local.yaml`,
    `${t}/${ABE_ENV_GLOB}`,
  ]),
];

/**
 * What a local session may reach (ADR 0020 CC6, ADR 0029): only environment access is held. Its
 * shell runs in Abe's own jail (`jailed`, Claude Code's sandbox off) built from these lists: it
 * reads none of `serve`'s state (its socket, `tmux`'s, every other session's folder) but for the
 * session's `abe` and its own folder, none of the person's secrets nor an env file of an
 * environment off (`secrets`), and connects to no Unix socket under those but its own; it writes
 * anywhere but Abe's state, config and plugins, the files that decide its reach
 * (`envReachFiles`) and the main checkout's git config and hooks (serve's own git runs them,
 * unjailed). Claude's file tools are held by the same reads and writes, by the checkout's
 * git config, hooks and worktree files and Claude Code's config (deny rules), and write nothing
 * outside the worktree (`fence.ts`, serve's answer to their PreToolUse: no deny rule can say "all
 * but here"). Paths are real paths (a symlink resolved): Claude Code matches a rule against the
 * path a link resolves to.
 */
export const sessionBoundary = (o: {
  /** `serve`'s state directory. */
  state: string;
  /**
   * The default state folders, when `state` is an own one (`ABE_STATE_DIR`, `XDG_STATE_HOME`):
   * another serve's, hidden as its own is.
   */
  defaultStates?: readonly string[];
  /** `serve`'s own socket; outside `state` when `ABE_SOCKET` puts it there. */
  serveSocket: string;
  /** Where each session's copy of core's plugin is written: read-only to sessions. */
  plugins: string;
  /** Your own Layer's folder (`ABE_CONFIG_DIR`, `~/.config/abe`): read-only to sessions. */
  config?: string;
  /** The session's own socket (`<state>/sessions/<id>/session.sock`). */
  socket: string;
  /** The main checkout it works from (its worktree is that repo's). */
  checkout: string;
  home: string;
  /**
   * A card's worktree (`worktreePath`), real: its `.git` file denied by name to the file tools (a
   * branch name with a slash nests it deeper than `<repo>-wt/*`), its Before worktree
   * (`baseWorktreePath`, #182) held the same. None for a chat's folder.
   */
  worktree?: string;
  /**
   * More its commands never read (ADR 0029): the person's secrets (`homeSecrets`), the Abe env
   * files and repo env files of environments off for agents, another checkout's.
   */
  secrets?: readonly string[];
}): SessionBoundary => {
  const own = parentOf(o.socket);
  const outside = o.serveSocket.startsWith(`${o.state}/`) ? [] : [o.serveSocket];
  const states = [o.state, ...(o.defaultStates ?? []).filter((d) => d !== o.state)];
  const gitConfig = `${o.checkout}/.git/config`;
  const gitHooks = `${o.checkout}/.git/hooks`;
  const worktrees = `${o.checkout}/.git/worktrees`;
  const modules = `${o.checkout}/.git/modules`;
  const base = o.worktree === undefined ? [] : [`${o.worktree}-base`];
  const gitFiles = [
    // Each worktree's own config (`extensions.worktreeConfig`): its pre-push hook's hooksPath.
    `${worktrees}/*/config.worktree`,
    // Where each worktree's repository is (its `commondir`, its `.git` file, #181).
    `${worktrees}/*/commondir`,
    `${worktrees}/*/gitdir`,
    `${parentOf(worktreePath(o.checkout, '*'))}/*/.git`,
    `${o.checkout}/.claude/worktrees/*/.git`,
    // The main checkout's own worktree config and where its repository is (#181).
    `${o.checkout}/.git/config.worktree`,
    `${o.checkout}/.git/commondir`,
    // A submodule's (at any depth: `**` takes none or more folders) config, worktree config and
    // repository, and its hooks below.
    `${modules}/**/config`,
    `${modules}/**/config.worktree`,
    `${modules}/**/commondir`,
  ];
  const submoduleHooks = `${modules}/**/hooks`;
  // Its own worktree, its Before worktree and its writers' (`isolation: worktree`).
  const trees = [
    ...(o.worktree === undefined ? [] : [o.worktree, ...base]),
    `${o.checkout}/.claude/worktrees/*`,
  ];
  const treesEdit = trees.flatMap(treeHeld).filter((r) => !r.endsWith('/*/.git)'));
  const reach = envReachFiles({ checkout: o.checkout, trees });

  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [...states, ...outside, ...(o.secrets ?? [])],
        allowRead: [`${o.state}/bin`, own],
        // writes open (ADR 0029) but Abe's own files, what decides its reach, and the main
        // checkout's git config and hooks, which serve's own git runs outside the jail (a commit
        // writes neither: its index, objects, refs, logs and worktree folder stay written)
        denyWrite: [
          ...states,
          ...(o.config === undefined ? [] : [o.config]),
          o.plugins,
          ...reach,
          gitConfig,
          gitHooks,
          `${o.checkout}/.git/config.worktree`,
          `${worktrees}/*/config.worktree`,
        ],
      },
      network: {
        allowUnixSockets: [o.socket],
        allowLocalBinding: true,
        // Claude Code's own sandbox is off for a local session (`jailed`): its jail holds
        // environment access, the network is open; these stand for a runner with no jail
        allowedDomains: [...SANDBOX_DOMAINS],
        strictAllowlist: true,
        allowMachLookup: [TRUSTD],
      },
    },
    // a writer's worktree (`isolation: worktree`) is a working folder: no ask per path in it
    directories: [`${o.checkout}/.claude/worktrees`],
    deny: [
      ...states.flatMap((state) => [`Read(${rulePath(state)}/**)`, `Edit(${rulePath(state)}/**)`]),
      // the person's secrets, from its file tools too
      ...(o.secrets ?? []).flatMap((p) => [
        `Read(${rulePath(p)})`,
        `Read(${rulePath(p)}/**)`,
        `Edit(${rulePath(p)})`,
        `Edit(${rulePath(p)}/**)`,
      ]),
      `Edit(${rulePath(o.plugins)}/**)`,
      ...(o.config === undefined ? [] : [`Edit(${rulePath(o.config)}/**)`]),
      // what decides its reach: its shell's denyWrite too
      ...reach.map((path) => `Edit(${rulePath(path)})`),
      ...outside.flatMap((path) => [`Read(${rulePath(path)})`, `Edit(${rulePath(path)})`]),
      `Edit(${rulePath(gitConfig)})`,
      `Edit(${rulePath(gitHooks)}/**)`,
      ...gitFiles.map((path) => `Edit(${rulePath(path)})`),
      `Edit(${rulePath(submoduleHooks)}/**)`,
      ...treesEdit,
      ...PROJECT_SETTINGS_DENY,
      ...SESSION_COMMAND_DENY,
      // Any push run in the main checkout, whose own hooks let one to the default branch through.
      `Bash(git -C ${o.checkout} push*)`,
      `Bash(git -C ${o.checkout}/ push*)`,
      ...HOME_BACKSTOP.map((path) => `Edit(${rulePath(`${o.home}/${path}`)})`),
    ],
  };
};

export type ClaudeHooks = Record<
  string,
  { hooks: { type: 'command'; command: string; timeout: number }[] }[]
>;

/** The Claude Code settings Abe writes (a `--settings` file, or a container's managed settings). */
export type ClaudeSettings = {
  hooks?: ClaudeHooks;
  /** The coordinator's model. */
  model?: string;
  /** `allowedModels` as Claude Code holds it: the main agent, subagents and a per-call model. */
  availableModels?: string[];
  /** The `/model` picker's rows (`sessionModelPicker`): what `abe session model` picks from (#180). */
  modelPicker?: ModelPicker;
  /** A writer's worktree (`isolation: worktree`) branches from the card branch, not the default. */
  worktree?: { baseRef: 'head' | 'fresh' };
  /**
   * `allow`: the `abe` commands the session runs without asking (`inSessionRules`); `deny`: what
   * Claude's file tools may never touch (a local session's `sessionBoundary`) or what a
   * workspace's managed settings keep from every tool (credential files, other sockets).
   */
  permissions?: {
    allow?: string[];
    deny?: string[];
    /** Asked each time (a Connected install's commands that write real systems). */
    ask?: string[];
    disableBypassPermissionsMode?: 'disable';
    /** The mode it starts in: a Factory run's `FACTORY_PERMISSION_MODE`. */
    defaultMode?: PermissionMode;
    /** Working folders besides its own: a local session's writers' worktrees. */
    additionalDirectories?: string[];
  };
  /** Managed settings only: no hook of another settings file (a project's) runs. */
  allowManagedHooksOnly?: boolean;
  /** Managed settings only: no allow, ask or deny rule of another file (`--settings` too) counts. */
  allowManagedPermissionRulesOnly?: boolean;
  /** CLAUDE.md files left out: the person's own, while `skillsOnTop` is off. */
  claudeMdExcludes?: string[];
  /** Claude Code's suggested next prompt: Enter on an empty input would send it. */
  promptSuggestionEnabled?: boolean;
  /** A chat of yours: none of the repo's `.mcp.json` servers approved without a prompt. */
  enableAllProjectMcpServers?: boolean;
  /** A chat of yours: each of the repo's `.mcp.json` servers, rejected in every mode. */
  disabledMcpjsonServers?: string[];
  /** Where the shell's commands run: a local session's `sessionBoundary`, a workspace's own. */
  sandbox?: {
    enabled?: boolean;
    failIfUnavailable?: boolean;
    allowUnsandboxedCommands?: boolean;
    excludedCommands?: string[];
    autoAllowBashIfSandboxed?: boolean;
    enableWeakerNestedSandbox?: boolean;
    filesystem?: {
      denyRead?: string[];
      allowRead?: string[];
      allowWrite?: string[];
      denyWrite?: string[];
    };
    credentials?: {
      files?: { path: string; mode: 'deny' }[];
      envVars?: { name: string; mode: 'deny' }[];
    };
    network?: {
      allowUnixSockets?: string[];
      allowAllUnixSockets?: boolean;
      allowLocalBinding?: boolean;
      allowedDomains?: string[];
      strictAllowlist?: boolean;
      allowMachLookup?: string[];
    };
  };
  /** Claude Code's auto memory (`~/.claude/projects/<project>/memory`); false: none. */
  autoMemoryEnabled?: boolean;
  /** Claude Code's own commit trailer and pull request footer: empty, so none is added. */
  attribution?: { commit: string; pr: string };
  /** Claude Code's effort for the session (the `effort` setting, #115). */
  effortLevel?: Effort;
  /** Variables Claude Code runs with (a box's managed settings: its commands' jail). */
  env?: Record<string, string>;
  /** The only MCP servers that start (`withServersAllowed`): a run's or a box's with sources. */
  allowedMcpServers?: { serverName: string }[];
};

/** Claude Code's permission modes Abe starts a session in. */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto';

/**
 * A Factory run's permission mode on this Mac: `auto`, so it runs on without stopping at a prompt
 * while you can still watch it in Chat. The sandbox (`autoAllowBashIfSandboxed`) and every deny
 * rule hold in it, unlike `bypassPermissions`.
 */
export const FACTORY_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * A Factory run's permission mode in a box's workspace: file edits without asking, and (the
 * sandbox's `autoAllowBashIfSandboxed`) every sandboxed command line, compound ones too. Not
 * `auto`, whose classifier may still stop and ask with nobody there; its hook answers the rest
 * (`unattendedAnswer`, #67). `bypassPermissions` is refused anyway (`disableBypassPermissionsMode`).
 */
export const WORKSPACE_PERMISSION_MODE: PermissionMode = 'acceptEdits';

/** The settings handed to `claude --settings`: `abe hook <event>` for every event in `HOOK_EVENTS`. */
export const hookSettings = (abe: string): { hooks: ClaudeHooks } => ({
  hooks: Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: 'command',
              command: `${abe} hook ${event}`,
              timeout: hookTimeout(event),
            },
          ],
        },
      ],
    ]),
  ),
});

/**
 * A local session's settings with the worktree its runner put it in (real path) held by name
 * (#181): the one `sessionBoundary` named, or a person's own worktree on the branch elsewhere,
 * past `<repo>-wt`: its `.git` and Claude Code's config from the file tools, your own settings
 * there (`.abe/settings.local.yaml`, `envReachFiles`) from its shell and file tools. A session with
 * no sandbox of ours (a box's) as it came.
 */
export const withWorktreeHeld = (settings: ClaudeSettings, worktree: string): ClaudeSettings => {
  const { sandbox } = settings;
  const denied = sandbox?.filesystem?.denyWrite;
  const local = `${worktree}/.abe/settings.local.yaml`;

  if (sandbox === undefined || denied === undefined || denied.includes(local)) return settings;

  return {
    ...settings,
    sandbox: { ...sandbox, filesystem: { ...sandbox.filesystem, denyWrite: [...denied, local] } },
    permissions: {
      ...settings.permissions,
      deny: [
        ...(settings.permissions?.deny ?? []),
        ...treeHeld(worktree),
        `Edit(${rulePath(local)})`,
      ],
    },
  };
};

/**
 * A session's settings: the hooks, the coordinator on its model, `allowedModels` held by Claude
 * Code itself, writers' worktrees off the card branch, its boundary (sandbox and deny rules), and
 * no attribution of Claude Code's own.
 */
export const sessionSettings = (o: {
  abe: string;
  models: SessionModels;
  allowedModels: readonly string[];
  /** Permission rules allowed without asking: every in-session `abe` command (`inSessionRules`). */
  allow: readonly string[];
  /** A local session's (`sessionBoundary`); none in a workspace, whose container is its boundary. */
  boundary?: SessionBoundary;
  /** The `skillsOnTop` setting, and the session's `HOME` whose `.claude/` it keeps out when off. */
  skillsOnTop: boolean;
  home: string;
  /** The mode it starts in (a Factory run's); none: the person's own default. */
  mode?: PermissionMode;
  /** Claude Code's effort (the `effort` setting); none: Claude Code's own default. */
  effort?: Effort;
}): ClaudeSettings => ({
  ...hookSettings(o.abe),
  model: o.models.coordinator,
  // An empty list would hold Claude Code to its Default model; the setting is never empty.
  ...(o.allowedModels.length === 0
    ? {}
    : {
        availableModels: [...o.allowedModels],
        modelPicker: sessionModelPicker(o.allowedModels),
      }),
  worktree: { baseRef: 'head' },
  permissions: {
    allow: [...o.allow],
    ...(o.boundary === undefined
      ? {}
      : { deny: [...o.boundary.deny], additionalDirectories: [...o.boundary.directories] }),
    ...(o.mode === undefined ? {} : { defaultMode: o.mode }),
  },
  ...(o.boundary === undefined ? {} : { sandbox: o.boundary.sandbox }),
  // Auto memory is written under `~/.claude/projects`, past a local session's fence (#181): none.
  ...(o.boundary === undefined ? {} : { autoMemoryEnabled: false }),
  // A repo under HOME reaches `~/.claude/CLAUDE.md` as an ancestor's `.claude/CLAUDE.md`, a
  // project source `--setting-sources` keeps: excluded by path.
  ...(o.skillsOnTop ? {} : { claudeMdExcludes: [personalClaudeMd(o.home)] }),
  // Commits and pull requests follow the repo's own style: no Co-Authored-By, no footer.
  attribution: { commit: '', pr: '' },
  // No suggested prompt: an Enter Abe sends to an input its paste missed would submit it.
  promptSuggestionEnabled: false,
  ...(o.effort === undefined ? {} : { effortLevel: o.effort }),
});

/**
 * The settings with `paths` read-only (a prototype chat's checkout, #81): Claude Code's Edit and
 * Write refused under each (an Edit rule holds for every tool that edits a file, NotebookEdit's
 * too: a NotebookEdit path rule never matches), and the sandbox refusing every write there too, so
 * no tool and no command changes them. Everything else of the settings stays as it was.
 */
export const readOnlyPaths = (
  settings: ClaudeSettings,
  paths: readonly string[],
  /** Single files kept the same way (a developer prototype's `config.worktree`, #83). */
  files: readonly string[] = [],
  /** More deny rules (a developer prototype's `git push`, #83). */
  rules: readonly string[] = [],
): ClaudeSettings => {
  if (paths.length === 0 && files.length === 0 && rules.length === 0) return settings;
  // an Edit rule holds every file tool that writes (Claude Code warns a Write rule never matches)
  const deny = [
    ...rules,
    ...paths.map((p) => `Edit(${rulePath(p)}/**)`),
    ...files.map((f) => `Edit(${rulePath(f)})`),
  ];
  const sandbox = settings.sandbox;

  return {
    ...settings,
    permissions: {
      ...settings.permissions,
      deny: [...(settings.permissions?.deny ?? []), ...deny],
    },
    ...(sandbox === undefined
      ? {}
      : {
          sandbox: {
            ...sandbox,
            filesystem: {
              ...sandbox.filesystem,
              denyWrite: [...(sandbox.filesystem?.denyWrite ?? []), ...paths, ...files],
            },
          },
        }),
  };
};

/** Every CLAUDE.md and rule file in the person's own `~/.claude/`, as a `claudeMdExcludes` glob. */
export const personalClaudeMd = (home: string): string => `${home.replace(/\/+$/, '')}/.claude/**`;

/** The setting sources a session loads with `skillsOnTop` off: the repo's, never the person's. */
export const SESSION_SETTING_SOURCES = 'project,local';

/**
 * `claude` in a session: its settings file, core's plugin, its Claude session id, core's
 * instructions after Claude Code's own system prompt, and the launch prompt; never Claude in
 * Chrome; with `skillsOnTop` off none of the person's setting sources. A repo's own MCP servers
 * (`.mcp.json`) never load: with `mcpMode` `abe-only` MCP servers come only from `--mcp-config`
 * (`--strict-mcp-config`), Abe's and the files its sources are in (`sourceMcp`); a chat of yours
 * (`yours`) is not strict, so the person's own servers and claude.ai connectors load, and its
 * settings reject the repo's (`withRepoMcpOff`).
 */
export const claudeArgv = (o: {
  claude: string;
  settings: string;
  pluginDir: string;
  /** The `skillsOnTop` setting: off, the person's own `~/.claude` (skills, plugins, CLAUDE.md, settings) stays out. */
  skillsOnTop: boolean;
  /**
   * `session.mcp` as the launch takes it: `yours` loads the person's own MCP servers too
   * (`personalMcp`), `abe-only` only those `mcpConfig` and `sourceMcp` name. Serve gives a card's
   * session, an install's, a Factory run and a box `abe-only`.
   */
  mcpMode: SessionMcp;
  /**
   * The person's Claude Code config (`<home>/.claude.json`) where it names MCP servers: with
   * `skillsOnTop` off the user source is left out, and their servers with it, so `yours` names it.
   */
  personalMcp?: string;
  claudeSession: string;
  /**
   * A moved (#88) or reopened (#343) session: Claude Code's own session file is there, `--resume`
   * continues it.
   */
  resume?: boolean;
  instructions: string;
  /** The first prompt; '' for none (a reopened conversation waits for you). */
  prompt: string;
  /** Abe's own MCP servers for the session (a workspace's or a Factory run's browser). */
  mcpConfig?: string;
  /**
   * `abe-only` in a Factory run or a box's session: the config files its repo's sources are in
   * (the config Abe generates of them), before Abe's own, so a server of Abe's name stays Abe's.
   */
  sourceMcp?: readonly string[];
}): string[] => {
  const abeOnly = o.mcpMode === 'abe-only';
  const configs = [
    ...(abeOnly ? (o.sourceMcp ?? []) : []),
    ...(o.mcpConfig === undefined ? [] : [o.mcpConfig]),
    ...(abeOnly || o.skillsOnTop || o.personalMcp === undefined ? [] : [o.personalMcp]),
  ];

  return [
    o.claude,
    '--settings',
    o.settings,
    '--plugin-dir',
    o.pluginDir,
    // Leaves out the user source; the login, `--settings` and `--plugin-dir` still load.
    ...(o.skillsOnTop ? [] : ['--setting-sources', SESSION_SETTING_SOURCES]),
    // Claude in Chrome drives the person's own Chrome with their sign-ins: never a session's.
    '--no-chrome',
    o.resume === true ? '--resume' : '--session-id',
    o.claudeSession,
    ...(configs.length === 0 ? [] : ['--mcp-config', ...configs]),
    // MCP servers only from `--mcp-config`: none of the person's, nor a repo's, nor a connector.
    ...(abeOnly ? ['--strict-mcp-config'] : []),
    '--append-system-prompt',
    o.instructions,
    ...(o.prompt === '' ? [] : [o.prompt]),
  ];
};

/** Where Figma's MCP server answers: its remote server, and the desktop app's own. */
const FIGMA_HOSTS = ['mcp.figma.com', '127.0.0.1:3845', 'localhost:3845'] as const;

/**
 * The person's own MCP servers (their Claude Code config's `mcpServers`) a prototype session
 * loads whatever `session.mcp` says: their Figma server, by a name with `figma` in it or a URL on
 * one of `FIGMA_HOSTS`, so a Figma link's design is read there. Names only; sorted.
 */
export const figmaServers = (servers: Readonly<Record<string, unknown>>): string[] =>
  Object.entries(servers)
    .filter(([name, def]) => {
      if (/figma/i.test(name)) return true;
      const url: unknown =
        typeof def === 'object' && def !== null ? Reflect.get(def, 'url') : undefined;

      const host =
        typeof url === 'string' ? /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] : undefined;

      return host !== undefined && FIGMA_HOSTS.some((h) => host.toLowerCase() === h);
    })
    .map(([name]) => name)
    .sort();

/**
 * A chat of yours (`session.mcp: yours`, not strict): the repo's own MCP servers off in its
 * settings, so only yours and your claude.ai connectors load. None approved without a prompt
 * (`enableAllProjectMcpServers: false`), and each server its `.mcp.json` names (`names`, read by
 * name only) rejected (`disabledMcpjsonServers`), whatever the person approved in the checkout.
 */
export const withRepoMcpOff = (
  settings: ClaudeSettings,
  names: readonly string[],
): ClaudeSettings => ({
  ...settings,
  enableAllProjectMcpServers: false,
  disabledMcpjsonServers: [...names],
});

/**
 * A prototype session (`/abe:prototype`, `abe prototype start`): the prototype it builds and the
 * card it is for (null: none yet). Its id's shape is `prototype.ts`'s `PrototypeId` (repeated:
 * that module reads this one's neighbours).
 */
export const PrototypeChatOf = z.object({
  id: z.string().regex(/^proto-[0-9a-f]{6}$/),
  card: z.number().int().positive().nullable(),
});
export type PrototypeChatOf = z.infer<typeof PrototypeChatOf>;

/**
 * The Abe chat (the hub, `abe chat`): its conversations per repo, in its main checkout, unjailed
 * on this Mac as the person's own Claude Code. `name`: the conversation's (`hubName`: its first
 * message's words, `Abe 2` until then; absent before conversations had names).
 */
export const AbeChatOf = z.object({
  repo: z.string(),
  name: z.string().optional(),
});
export type AbeChatOf = z.infer<typeof AbeChatOf>;

/**
 * What a session is: a card's (a Factory run or a plain launch), a prototype session (where cards
 * run, on a throwaway `proto/…` worktree that never ships, with or without a card), or the repo's
 * Abe chat (`abe`).
 */
export const SESSION_KINDS = ['card', 'prototype', 'abe'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** Claude Code's effort levels a session runs at (#115; the `effort` setting's). */
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

/**
 * A message `serve` holds back (#115, #197): a working session gets yours typed in at once, into
 * Claude Code's own queue, which takes it at the agent's next step; only one that cannot take
 * keys yet (`HOLDS`) has it held, then typed in with the others as one prompt. `n` names it for
 * `abe session unqueue`; `text` is what you typed.
 */
export const QueuedRow = z.object({ n: z.number().int().positive(), text: z.string() });
export type QueuedRow = z.infer<typeof QueuedRow>;

/** A queued message as `serve` keeps it: the prompt it goes as, its implicit context with it. */
export const QueuedMessage = QueuedRow.extend({ prompt: z.string() });
export type QueuedMessage = z.infer<typeof QueuedMessage>;

/**
 * A session as it is kept and sent, without its kind: `SessionData` derives that. `since`
 * (RFC 3339) is when its state last changed. A card's session names its card; the Abe chat
 * (`abe`) has none and runs in the repo's main checkout (`worktree`), no branch.
 */
export const SessionRecord = z.object({
  id: z.string(),
  card: z.number().int().positive().nullable(),
  /** A prototype session's prototype; null otherwise. */
  prototype: PrototypeChatOf.nullable().default(null),
  /** The Abe chat's repo; null or absent otherwise. */
  abe: AbeChatOf.nullable().optional(),
  title: z.string(),
  repo: z.string(),
  worktree: z.string(),
  branch: z.string(),
  /** The box it runs on in your environment (`<repo>-<card>`); absent for a local one. */
  box: z.string().optional(),
  /**
   * It never got a box (#234, #246): taken out of the queue (Stop…, End run…) or refused there
   * before one had it. `box` is the one it waited for, never made: it has no Workspace.
   */
  neverPlaced: z.boolean().optional(),
  /**
   * A Factory run's session (`abe factory run`, #332); absent for a plain one (`abe session
   * launch`). Once its run is no longer shown (cleared), it no longer stands for its card.
   */
  factory: z.literal(true).optional(),
  state: z.enum(SESSION_STATES),
  since: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  /** From the hooks' `transcript_path`; null until the first hook. */
  transcriptPath: z.string().nullable(),
  /** From the last `Stop` hook's `last_assistant_message`; null until one came. */
  lastAssistantMessage: z.string().nullable(),
  /** The models it was launched on (null: launched before #65). */
  models: SessionModels.nullable().default(null),
  /** Its subagent runs, oldest first, from the hooks. */
  subagents: z.array(SubagentRun).default([]),
  /** Why Abe ended it (its `claude` never started, `NO_START`); null otherwise. */
  reason: z.string().nullable().default(null),
  /**
   * You ended it (`abe session stop`), or Abe did at its run's Done (#304): it did not end on its
   * own: Stopped, not Failed (#205).
   */
  stopped: z.boolean().default(false),
  /** The repo pack's setup as it ran in the worktree made at launch; null when none ran. */
  setup: SetupRan.nullable().default(null),
  /** Where its branch was made from at launch (#198); absent when the branch was there already. */
  base: BranchBase.optional(),
  /**
   * The repo's sources no MCP config names where it runs (a Factory run, a box's session): they
   * did not load, and it was told so (`sourcesTold`). Absent: none.
   */
  sourcesMissing: z.array(z.string()).optional(),
  /** `skillsOnTop` as it was at launch: the person's own skills, plugins and rules loaded too. */
  skillsOnTop: z.boolean().default(false),
  /**
   * The browser profile its verify browser starts in (#103): `--profile` at launch, else
   * `browser.default`; `default` is the built-in empty one. A Factory run keeps it for Before and After.
   */
  browserProfile: z.string().default('default'),
  /** Its Overrides (#114), oldest first: each lowers one area until the session ends. */
  overrides: readOverrides.default([]),
  /**
   * Prod on for agents for this session alone (ADR 0029): the person turned it on at its launch
   * (`abe factory run --prod`), whatever the repo's settings say; it reaches prod in full.
   */
  prodOn: z.literal(true).optional(),
  /** Messages held back (#115, #197), oldest first: they go as one prompt once it takes keys. */
  queue: z.array(QueuedRow).default([]),
  /** The coordinator's model now: its launch's, or the last `abe session model`; null before #115. */
  model: z.string().nullable().default(null),
  /** Claude Code's effort now; null: Claude Code's own default. */
  effort: Effort.nullable().default(null),
  /**
   * A cloud launch Queued at `limits.maxBoxesPerPerson` (#194): your boxes that counted then
   * (running or starting) and the limit, so it says why and until when.
   */
  queuedFor: z
    .object({ boxes: z.array(z.string()), limit: z.number().int().positive() })
    .optional(),
  /** While a session in your environment starts: the launch step it is at (#142); else null. */
  launch: LaunchProgress.nullable().default(null),
  /** Your Launch note (#347); absent or null without. */
  note: LaunchNote.nullable().optional(),
  /** The standing notes in force at launch (#347). */
  standing: z.array(StandingNote).optional(),
  /**
   * Each time it was reopened (#343: the same session, worktree and Claude Code conversation),
   * oldest first: Chat's `Reopened <when>` dividers.
   */
  reopened: z.array(z.iso.datetime()).default([]),
  /**
   * Its question rounds asked so far (#342): each AskUserQuestion call, a grill round or one
   * question; a run in its grill waits on round `rounds`, or works on the next.
   */
  rounds: z.number().int().nonnegative().default(0),
  /**
   * What it waits on while waiting (#115, `WAITING_ON`): its turn ended (`turn`: idle, your turn),
   * a question card of Chat's (`question`), or a dialog of Claude Code's in its terminal
   * (`dialog`), which keys typed into it would answer; null otherwise. Only the last two need you
   * (`waitsOnYou`).
   */
  waitingOn: z.enum(WAITING_ON).nullable().default(null),
  /**
   * Working with its own turn ended (`turnEndedAfter`): only its background subagents work, it
   * waits at its prompt. Absent otherwise.
   */
  turnEnded: z.literal(true).optional(),
  /**
   * A card's launch only, never kept: another checkout of the same origin works on its branch (a
   * live session there or in your environment), or origin has it though it was made here now. One
   * line (`launchSharedNote`): both push one branch and pull request; never a refusal.
   */
  branchShared: z.string().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/** What a session's kind is read from (`sessionKind`): what it is on. */
type KindFrom = Pick<SessionRecord, 'card' | 'prototype'> & { abe?: AbeChatOf | null | undefined };

/** A session's kind from what it is on. */
const sessionKind = (s: KindFrom): SessionKind => {
  if (s.abe !== undefined && s.abe !== null) return 'abe';
  if (s.prototype !== null) return 'prototype';

  return 'card';
};

/**
 * A record with its kind (`sessionKind`): what every read of a session's file or answer goes
 * through (`SessionData`, `SessionMeta`), and how a new one is made. The one place `kind` comes
 * from, so it never disagrees with the fields it is read from.
 */
export const withKind = <T extends KindFrom>(s: T): T & { kind: SessionKind } => ({
  ...s,
  kind: sessionKind(s),
});

/**
 * What `abe session` prints about one session: its record with its kind, derived on every read
 * (`withKind`). A `kind` in the document read is not believed: an older file has none, or
 * `card` by default; the answer still names it, for whoever reads it as text.
 */
export const SessionData = SessionRecord.transform(withKind);
export type SessionData = z.infer<typeof SessionData>;

/** This Mac, or your environment (a Workspace on its box): where a session runs (#88). */
export const MOVE_SIDES = ['local', 'cloud'] as const;
export type MoveSide = (typeof MOVE_SIDES)[number];

/** Where a moved session went (#88), on the side it left: it goes on there. */
export const Moved = z.object({
  to: z.enum(MOVE_SIDES),
  at: z.iso.datetime(),
  /** Where it went: the local worktree, or the box. */
  where: z.string(),
});
export type Moved = z.infer<typeof Moved>;

/**
 * What `serve` keeps of a session in its `meta.json`, so a restarted `serve` knows it; its kind
 * derived as `SessionData`'s. The file still names it (written from the record), so an older
 * `serve` reading it keeps it.
 */
const SessionMetaRecord = SessionRecord.extend({
  v: z.literal(1),
  /** The `--session-id` it was started with. */
  claudeSession: z.string(),
  socket: z.string(),
  /** `allowedModels` at launch: a per-call model is held to it. */
  allowedModels: z.array(z.string()).default([]),
  /** Agent calls whose `SubagentStart` has not come yet. */
  agentCalls: z.array(AgentCall).default([]),
  /**
   * Its subagents that ran in a git worktree of their own (a writer's), by id, however old: its
   * writers' tidy still finds them once their runs are no longer kept. Absent: none yet.
   */
  writers: z.array(z.string()).optional(),
  /** Until its first hook: when its `claude` must have run one by (`startBy`); then null. */
  startBy: z.iso.datetime().nullable().default(null),
  /** Moved to your environment (#88, Move to cloud): it goes on there, this record is history. */
  moved: Moved.nullable().default(null),
  /**
   * Nobody is at its prompts: a Factory run in a workspace, whose permission prompts its hook
   * answers (`unattendedAnswer`, #67).
   */
  unattended: z.boolean().default(false),
  /** Its open question, grill and permission cards (#114), oldest first. */
  asks: z.array(AskCard).default([]),
  /** Prompts allowed for the rest of the session from a permission card (`Allow for this session`). */
  allowed: z.array(z.object({ tool: z.string(), input: z.string() })).default([]),
  /** The queue with each message's prompt (#115). */
  queue: z.array(QueuedMessage).default([]),
  /** The next queued message's `n`: never one taken back (`abe session unqueue`) again. */
  queueNext: z.number().int().positive().default(1),
  /** An Abe chat conversation: when Chat last showed it (its tab, `abe chat --shown`). */
  shown: z.iso.datetime().optional(),
});
export const SessionMeta = SessionMetaRecord.transform(withKind);
export type SessionMeta = z.infer<typeof SessionMeta>;

export const SessionListData = z.object({
  sessions: z.array(SessionData),
  /**
   * In your environment, when your boxes could not be read: why, and the way on
   * (`boxesUnreadText`); else each running box that did not answer and where it stands
   * (`boxReachText`).
   */
  boxes: z.string().optional(),
  /** The repo it was read in (#256): which of the sessions are the shown repo's. */
  here: RepoHere.optional(),
});
export type SessionListData = z.infer<typeof SessionListData>;

/**
 * Why `serve` holds a message back rather than type it in (#197): its `claude` has not started
 * (keys would land in its trust dialog, or wait for its whole first turn), a dialog of Claude
 * Code's asks in its terminal (a permission prompt: keys would answer it), or a question card of
 * Chat's waits for its answer while the agent ends its turn (#114: it goes with the answer).
 */
export const HOLDS = ['starting', 'dialog', 'question'] as const;
export const Hold = z.enum(HOLDS);
export type Hold = z.infer<typeof Hold>;

export const SessionSendData = z.object({
  id: z.string(),
  /** The prompt as it goes (or will go): the message and its implicit context (`context.ts`). */
  sent: z.string(),
  /** Held back (#115, #197): the message's `n`; null when it was typed in now. */
  queued: z.number().int().positive().nullable().default(null),
  /** Why it is held; absent: typed in now, or after the messages held before it. */
  held: Hold.optional(),
});
export type SessionSendData = z.infer<typeof SessionSendData>;

/** `abe session unqueue`: the queue left. */
export const SessionUnqueueData = z.object({ id: z.string(), queue: z.array(QueuedRow) });
export type SessionUnqueueData = z.infer<typeof SessionUnqueueData>;

/**
 * `abe session model` (#115): the model and effort recorded. `effortPending`: the effort applies
 * at the session's next resume, not now (Claude Code 2.1.310 has a live `/effort`: always false).
 */
export const SessionModelData = z.object({
  id: z.string(),
  model: z.string(),
  effort: Effort.nullable(),
  effortPending: z.boolean(),
});
export type SessionModelData = z.infer<typeof SessionModelData>;

/** `abe session attach --json`: the command that attaches; without `--json` the CLI runs it. */
export const SessionAttachData = z.object({ id: z.string(), argv: z.array(z.string()) });
export type SessionAttachData = z.infer<typeof SessionAttachData>;

/**
 * `abe hook`: where the session stands after the event; `answer` is what the hook prints: a
 * PermissionRequest's of a session nobody watches (a Factory run in a workspace) or one answered
 * on its permission card, AskUserQuestion's PreToolUse deny (#114).
 */
export const HookData = z.object({
  id: z.string(),
  event: z.string(),
  state: z.enum(SESSION_STATES),
  answer: HookAnswer.optional(),
});
export type HookData = z.infer<typeof HookData>;

const STATE_WORDS: Readonly<Record<SessionState, string>> = {
  queued: 'queued',
  starting: 'starting',
  working: 'working',
  waiting: 'waiting on you',
  ended: 'ended',
};

export const stateWords = (state: SessionState): string => STATE_WORDS[state];

/**
 * A session's state in words: waiting on its turn alone, `idle` (your turn, nothing asked);
 * waiting on a question or a dialog, `waiting on you`.
 */
export const sessionStateWords = (s: {
  state: SessionState;
  waitingOn?: WaitingOn | null | undefined;
}): string => (s.state === 'waiting' && s.waitingOn === 'turn' ? 'idle' : stateWords(s.state));

/** What a session is on: its card, the prototype it builds, or the repo (the Abe chat). */
export const sessionSubject = (s: KindFrom): string => {
  if (s.card !== null) return `AB#${s.card}`;
  if (s.prototype !== null) return `prototype ${s.prototype.id}`;

  return 'Abe chat';
};

/** One queued message, as `abe session unqueue` and `show` list it. */
const queuedText = (q: QueuedRow) => `${q.n}  ${q.text.split('\n')[0] ?? ''}`;

export { modelName };

/** `opus · medium`, as the composer's model line says it. */
export const modelWords = (s: { model: string; effort: Effort | null }): string =>
  s.effort === null ? modelName(s.model) : `${modelName(s.model)} · ${s.effort}`;

/** `waiting on you since 12:35` (`idle since 18:04`), local time (#194); a queued launch says why. */
const stateLine = (s: SessionData, at?: TextAt) =>
  `${sessionStateWords(s)} since ${localWhen(s.since, at?.now)}${
    s.state === 'queued' && s.queuedFor !== undefined ? `: ${queuedForText(s.queuedFor)}` : ''
  }`;

const oneLine = (s: SessionData, at?: TextAt, repo?: string) =>
  `${s.id}  ${sessionSubject(s)}${repo === undefined ? '' : ` in ${repo}`}  ${stateLine(s, at)}  ${s.branch}${s.box === undefined ? '' : `  on ${s.box}`}`;

export const sessionText = (s: SessionData, at?: TextAt): string =>
  `${[
    oneLine(s, at),
    `  ${s.title}`,
    `  worktree    ${s.worktree}`,
    `  transcript  ${s.transcriptPath ?? '(no hook yet)'}`,
    ...(s.models === null
      ? []
      : [
          `  models      ${s.models.coordinator}, reader ${s.models.reader}, writer ${s.models.writer}`,
        ]),
    ...(s.subagents.length === 0
      ? []
      : ['  subagents', ...s.subagents.map((r) => `    ${subagentText(r)}`)]),
    ...(s.setup === null ? [] : [`  setup       ${setupText(s.setup)}`]),
    ...(s.base === undefined ? [] : [`  base        ${branchBaseText(s.base)}`]),
    ...(s.sourcesMissing === undefined
      ? []
      : [`  sources     not loaded here: ${s.sourcesMissing.join(', ')}`]),
    ...s.overrides.map((o) => `  override    ${o.words} · reason: ${o.reason}`),
    ...noteLines(s.note, s.standing),
    ...(s.model === null
      ? []
      : [`  model       ${modelWords({ model: s.model, effort: s.effort })}`]),
    ...(s.queue.length === 0 ? [] : ['  held', ...s.queue.map((q) => `    ${queuedText(q)}`)]),
    ...(s.reason === null ? [] : [`  ended       ${s.reason}`]),
    ...(s.lastAssistantMessage === null ? [] : ['', s.lastAssistantMessage]),
  ].join('\n')}\n`;

/**
 * Your boxes not read (no AWS login, AWS refusing, EC2 not answering): only this Mac's sessions
 * are shown, and `serve.target: local` keeps you here without asking AWS at all.
 */
export const boxesUnreadText = (message: string): string =>
  `your boxes were not read, so only this machine's sessions are shown: ${message} (or set serve.target: local in a Layer to stay on this machine)`;

/** A launch's note: its branch shared with another checkout of the same origin (`abe: …`). */
export const launchSharedNote = (l: { branchShared?: string | undefined }): string =>
  l.branchShared === undefined ? '' : `abe: ${l.branchShared}\n`;

/** `session list`'s note on your boxes, a line each (`abe: …`). */
export const sessionListNote = (l: SessionListData): string =>
  l.boxes === undefined
    ? ''
    : l.boxes
        .split('\n')
        .map((line) => `abe: ${line}\n`)
        .join('');

/** A session's repo as a row names it: a checkout's folder name, a cloud one's `owner/name`. */
const repoWords = (repo: string) =>
  repo.startsWith('/')
    ? (repo
        .split('/')
        .filter((p) => p !== '')
        .at(-1) ?? repo)
    : repo;

/** One row per session; where they span more than one repo, each says its own (`in shop`). */
export const sessionListText = (l: SessionListData, at?: TextAt): string => {
  if (l.sessions.length === 0) return 'no sessions\n';
  const several = new Set(l.sessions.map((s) => s.repo)).size > 1;

  return `${l.sessions
    .map((s) => (several ? oneLine(s, at, repoWords(s.repo)) : oneLine(s, at)))
    .join('\n')}\n`;
};

const HELD_WORDS: Record<Hold, string> = {
  starting: 'its claude has not started yet; typed in once it runs',
  dialog: 'a permission prompt waits for your answer; typed in once it is answered',
  question: 'a question card waits for your answer; it goes with the answer',
};

/** Why a message is held, as `abe session send` says it (#197). */
export const heldWords = (hold: Hold): string => HELD_WORDS[hold];

export const sessionSendText = (s: SessionSendData): string =>
  s.queued === null
    ? `sent to ${s.id}\n`
    : `held as ${s.queued} for ${s.id}: ${s.held === undefined ? 'typed in after the messages held before it' : HELD_WORDS[s.held]}\n`;

export const sessionUnqueueText = (u: SessionUnqueueData): string =>
  u.queue.length === 0
    ? `nothing queued for ${u.id}\n`
    : u.queue.map((q) => `${queuedText(q)}\n`).join('');

/** `abe session stop`: one line, the session stopped and what stays (`session show` has the rest). */
export const sessionStopText = (s: SessionData): string =>
  `stopped ${s.id}  ${sessionSubject(s)}: its worktree and branch ${s.branch} stay${s.box === undefined ? '' : ` on ${s.box}`}\n`;

export const sessionModelText = (m: SessionModelData): string =>
  `${m.id} on ${modelWords(m)}${m.effortPending ? ' (effort at the next resume)' : ''}\n`;

export const sessionAttachText = (a: SessionAttachData): string => `${a.argv.join(' ')}\n`;

/** `abe hook` prints nothing: Claude Code reads a hook's stdout. */
