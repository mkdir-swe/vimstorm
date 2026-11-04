/**
 * A Claude Code session in the box's workspace container (spec #37, ADR 0020): its sockets under
 * the workspace's mounted socket folder, its clean environment (the allowlist, `DATABASE_URL`, the
 * Reach names, the person's Claude Code login), and the container's managed settings: the hooks,
 * the sandbox on, the credential files and the other sockets denied, the main model from the
 * agents' definitions lowered by `allowedModels` (`sessionModels`).
 */
import { z } from 'zod';
import { LaunchNote, StandingNote } from '../factory/launch-note';
import { CardComment } from '../board/board';
import { sessionModelPicker } from '../session/model-pick';
import { GITHUB_LOGIN, isWriteName, parseReachName } from '../layer/settings';
import { sessionModels, type SessionModels } from '../skills/subagents';
import { RunWorkflow } from '../skills/workflow/run';
import {
  type ClaudeSettings,
  hookSettings,
  MERGE_DENY,
  PROJECT_SETTINGS_DENY,
  SESSION_SOCKET,
  SESSION_TERM,
} from '../session/session';
import { JAIL_PLACEHOLDERS, RUN_GROUP, SOCKET_MOUNT } from './workspace';
import { SHELL_PREFIX_ENV } from '../session/seatbelt';
import { type RepoHooks, type RunScript, runScriptIn } from '../repo-hooks';
import { SYNC_DIR, SYNC_LOCKED, SYNC_SOURCE_VALUES } from './box-sync';

/** Where the workspace container's sessions keep their own sockets, under the socket folder. */
export const SESSION_SOCKETS = 's';

/** A session's socket folder under a socket folder (the box's, or the container's mount). */
export const boxSessionDir = (socketDir: string, id: string): string =>
  `${socketDir}/${SESSION_SOCKETS}/${id}`;

export const boxSessionSocket = (socketDir: string, id: string): string =>
  `${boxSessionDir(socketDir, id)}/${SESSION_SOCKET}`;

/**
 * Whether a session's socket is one in the workspace container (under the box's socket folder,
 * `boxSessionSocket`): only those answer the workspace's narrower set. A session the box's `serve`
 * runs any other way (a local runner's, `<state>/sessions/<id>/session.sock`) is scoped like any
 * local session's.
 */
export const isWorkspaceSessionSocket = (socket: string, socketDir: string): boolean =>
  socket.startsWith(`${socketDir.replace(/\/+$/, '')}/${SESSION_SOCKETS}/`);

/** The workspace socket every request on which is the workspace's (`status`, the browser). */
export const WORKSPACE_SOCKET = 'serve.sock';

/** The session MCP config `abe browser` reads from (#66): `/run/abe/mcp.json` inside. */
export const MCP_CONFIG = `${SOCKET_MOUNT}/mcp.json`;

/** Where Claude Code reads managed settings on Linux. */
export const MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';

/** The base image's user and home (`abe/images/base`), and the container's own `PATH`. */
export const CONTAINER = {
  user: 'abe',
  /** The session user's uid and gid (the node image's 1000). */
  uid: 1000,
  home: '/home/abe',
  /**
   * The workspace's second user (#67): code the agent wrote that runs outside the sandbox (the
   * checks, the repo pack's `setup`, the Verification pack's scripts through `abe run`) runs as
   * it. It shares the clone and `.scratch` with `abe` through the `group` (setgid folders, umask
   * 002) and never reads `abe`'s home (mode 700: Claude Code's login, gh's), its processes'
   * environment or the session sockets.
   */
  runUser: 'abe-run',
  group: RUN_GROUP,
  workdir: '/workspace/repo',
  /**
   * Claude Code's conversations (`~/.claude/projects`), on the workspace volume (#343): a new
   * container (a release's image) keeps them, so a reopen finds its conversation.
   */
  conversations: '/workspace/.claude-conversations',
  /** Before's worktree beside the clone, on the same volume (`abe factory base-worktree`). */
  baseWorktree: '/workspace/repo-base',
  path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  /** tmux's default server for uid 1000: the one the container's `main` session and probes use. */
  tmuxDir: '/tmp/tmux-1000',
} as const;

/** The container's own variables a session keeps: its database and which card it is. */
export const INHERITED = ['DATABASE_URL', 'ABE_WORKSPACE'] as const;

/** What the base image sets that `env -i` would lose (`abe/images/base/Dockerfile`). */
const IMAGE_ENV = {
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CHROME_PATH: '/usr/bin/chromium',
};

/** The variable Claude Code reads its login from (a `claude setup-token` token). */
export const CLAUDE_LOGIN = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * A box session's whole environment: the allowlist (`HOME`, `USER`, `PATH`, `TERM`, `LANG`, its
 * own `ABE_SOCKET`), the image's fixed switches, the container's `DATABASE_URL` and
 * `ABE_WORKSPACE`, the Reach names (writes only where granted: `reachVars(…, 'cloud')` already
 * kept only those) and the person's Claude Code login, and nothing else.
 */
export const boxSessionEnv = (o: {
  socket: string;
  /** Where `abe` is (first on `PATH`), the session's home and user: the container's by default. */
  bin?: string;
  home?: string;
  user?: string;
  reach: Readonly<Record<string, string>>;
  inherited: Readonly<Record<string, string>>;
  claudeLogin: string;
  /** The write names this person was granted: any other write name is refused. */
  granted: readonly string[];
}): { ok: true; env: Record<string, string> } | { ok: false; code: string; message: string } => {
  // Only the four fixed shapes: `ABE_SOCKET` or any other `ABE_*` name is no Reach name.
  const foreign = Object.keys(o.reach).filter((name) => parseReachName(name) === undefined);

  if (foreign.length > 0)
    return { ok: false, code: 'not-reach', message: `not a Reach name: ${foreign.join(', ')}` };
  const ungranted = Object.keys(o.reach).filter(
    (name) => isWriteName(name) && !o.granted.includes(name),
  );

  if (ungranted.length > 0)
    return {
      ok: false,
      code: 'write-name',
      message: `a write name that was not granted: ${ungranted.join(', ')}`,
    };
  const inherited = Object.fromEntries(
    INHERITED.flatMap((name) => {
      const value = o.inherited[name];

      return value === undefined || value === '' ? [] : [[name, value]];
    }),
  );

  return {
    ok: true,
    env: {
      HOME: o.home ?? CONTAINER.home,
      USER: o.user ?? CONTAINER.user,
      PATH: [
        ...new Set([...(o.bin === undefined ? [] : [o.bin]), ...CONTAINER.path.split(':')]),
      ].join(':'),
      TERM: SESSION_TERM,
      LANG: 'C.UTF-8',
      ...IMAGE_ENV,
      ...inherited,
      ...o.reach,
      [CLAUDE_LOGIN]: o.claudeLogin,
      ABE_SOCKET: o.socket,
    },
  };
};

/** Credential files no sandboxed command and no file tool reads. */
const CREDENTIAL_FILES = [
  '~/.claude/.credentials.json',
  '~/.aws/credentials',
  '~/.aws/sso',
  '~/.aws/cli',
  '~/.ssh',
  // your restored personal logins (aws's own HOME, `AWS_LOGIN_HOME`): Abe's checks only
  '~/.abe/logins',
  // what the Mac's serve synced (3.2.1): the sources' tokens and your values, the aws keys
  `~/${SYNC_DIR}`,
];

/**
 * The sessions' variables files (`~/.abe/sessions/<id>/env`, the workspace runner's): each holds
 * the Claude login until the session's shell has read it; and their generated MCP configs
 * (`sources.json`), with your values for the sources' references. The file tools are denied the
 * files (the session's plugin, its skills' files, is beside them); the sandbox, which takes no
 * glob on Linux, the whole folder, so no command reads another session's.
 */
const SESSION_FILES = `${CONTAINER.home}/.abe/sessions`;
const SESSION_FILE_RULES = ['Read(~/.abe/sessions/*/env)', 'Read(~/.abe/sessions/*/sources.json)'];

/**
 * Every secret in the workspace container, one example path each, and what it holds. The managed
 * deny rules (`managedSettings`) must cover each for the file tools and for sandboxed commands;
 * its test fails one they miss, so a new secret goes here. They are what keeps a secret from a
 * file tool, not the hook's link check (a race: `permission.ts`). gh's login (`hosts.yml`) is no
 * entry on purpose: the session's own `gh` and `git push` run as the person.
 */
export const CONTAINER_SECRETS: readonly { path: string; holds: string }[] = [
  { path: `${CONTAINER.home}/.claude/.credentials.json`, holds: "Claude Code's login" },
  { path: `${CONTAINER.home}/.aws/credentials`, holds: 'AWS keys' },
  { path: `${CONTAINER.home}/.aws/sso/cache/token.json`, holds: 'an AWS SSO token' },
  { path: `${CONTAINER.home}/.aws/cli/cache/role.json`, holds: 'AWS session credentials' },
  { path: `${CONTAINER.home}/.ssh/id_ed25519`, holds: 'an SSH key' },
  {
    path: `${CONTAINER.home}/.abe/logins/aws/.aws/config`,
    holds: 'your personal aws profile (restored login)',
  },
  {
    path: `${CONTAINER.home}/.abe/logins/aws/.aws/sso/cache/0a1b2c.json`,
    holds: 'your personal AWS SSO token (restored login)',
  },
  { path: `${CONTAINER.home}/${SYNC_DIR}/mcp.json`, holds: "the sources' access tokens (synced)" },
  {
    path: `${CONTAINER.home}/${SYNC_DIR}/aws/test.json`,
    holds: "an environment's aws keys (synced)",
  },
  {
    path: `${CONTAINER.home}/${SYNC_SOURCE_VALUES}`,
    holds: "your values for the sources' references (synced)",
  },
  { path: `${SOCKET_MOUNT}/${WORKSPACE_SOCKET}`, holds: "the workspace's serve" },
  { path: `${SOCKET_MOUNT}/${SESSION_SOCKETS}/9-other/session.sock`, holds: "another session's" },
  { path: `${CONTAINER.tmuxDir}/default`, holds: "the container's tmux: typing into a terminal" },
  { path: '/proc/1/environ', holds: "a process's environment: the Claude login" },
  { path: '/proc/self/environ', holds: "the reader's own environment" },
  { path: `${SESSION_FILES}/9-other/env`, holds: "a session's variables: the Claude login" },
  {
    path: `${SESSION_FILES}/9-other/sources.json`,
    holds: "a session's MCP config: your values for the sources' references",
  },
];

/**
 * The trees a box session works in, as its commands and file tools see them: the clone and
 * Before's worktree beside it. Its access rules name these (`accessRules`), never the box's paths.
 */
export const BOX_TREES: readonly string[] = [CONTAINER.workdir, CONTAINER.baseWorktree];

/**
 * What decides a box session's reach (ADR 0029, 0030), by its paths in the clone and Before's
 * worktree (no glob on Linux): the repo's settings, yours, the Abe env files. Written by none of
 * its commands (`boxJailScript`) nor its file tools (`managedSettings`), there or not, so no agent
 * turns an environment on for itself.
 */
const BOX_REACH_FILES = BOX_TREES.flatMap((tree) => JAIL_PLACEHOLDERS.map((f) => `${tree}/${f}`));

/**
 * What a box session's `abe run` runs (`runScriptIn` over the clone and Before's worktree): the
 * roles' scripts and the run-app skill's and the pack's helpers by `hooks`, the map the Mac
 * resolved from its committed `abe.yaml` and handed at launch, never the clone's.
 */
export const packScript = (hooks: RepoHooks, path: string): RunScript | undefined =>
  runScriptIn(hooks, { workdir: CONTAINER.workdir, base: CONTAINER.baseWorktree }, path);

/** How long `abe run` lets a pack script run (a start that installs packages and migrates). */
export const PACK_SCRIPT_TIMEOUT_MS = 10 * 60_000;

/** `abe run`'s answer: the script, where it ran, and what it printed and exited with. */
export const RunData = z.object({
  script: z.string(),
  cwd: z.string(),
  /** null: killed at `PACK_SCRIPT_TIMEOUT_MS`. */
  exit: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  /**
   * A local session's start against what the gate would not pass (`beforeRunWarning`): the
   * session shows it to the person. Absent: nothing to warn of.
   */
  warning: z.string().optional(),
});
export type RunData = z.infer<typeof RunData>;

/** Its warning first, what the script printed, stderr then stdout (its URL last), and its exit when not 0. */
export const runText = (r: RunData): string => {
  const out = [r.stderr, r.stdout].map((t) => (t === '' || t.endsWith('\n') ? t : `${t}\n`));
  const end =
    r.exit === 0
      ? ''
      : `[${r.script} ${r.exit === null ? `killed after ${PACK_SCRIPT_TIMEOUT_MS / 60_000} min` : `exited ${r.exit}`}]\n`;

  return `${r.warning === undefined ? '' : `${r.warning}\n`}${out.join('')}${end}`;
};

/** `gh api user`, cut to what a commit's author needs. */
const GhUser = z.object({
  login: z.string().regex(GITHUB_LOGIN),
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
});

/**
 * The person's git identity for the workspace's commits (#67): their GitHub name (else login)
 * and GitHub's noreply address for their account, `<id>+<login>@users.noreply.github.com`.
 */
export const gitAuthor = (user: unknown): { name: string; email: string } | undefined => {
  const read = GhUser.safeParse(user);

  if (!read.success) return undefined;
  const { login, id, name } = read.data;

  return {
    name: name?.trim() === '' || name === null || name === undefined ? login : name.trim(),
    email: `${id}+${login}@users.noreply.github.com`,
  };
};

/**
 * A workspace session's socket folder on the box (mounted at `/run/abe/s/<id>`): only the
 * session's user goes through it, never the script user (#67). A root serve (the stand-in box)
 * gives it to that uid; any other keeps it as its own, closed (a box's serve is that uid; one that
 * is not leaves the session unable to reach its socket, never the folder open to the script user).
 */
export const sessionDirAccess = (
  serveUid: number,
): { mode: number; chown?: readonly [number, number] } =>
  serveUid === 0 ? { mode: 0o700, chown: [CONTAINER.uid, CONTAINER.uid] } : { mode: 0o700 };

/** Where a box session's jail wrapper is, written as root beside the managed settings. */
export const BOX_JAIL = '/etc/claude-code/abe-jail.sh';

/**
 * What a box session's commands never see (ADR 0029): the person's secrets in the container's
 * home (`HOME_SECRETS`'s, Claude Code's login, the restored logins), every session's variables
 * files, and the other sockets (serve's, every session's but its own, tmux's).
 */
export const BOX_HIDDEN = [
  ...['.ssh', '.aws', '.azure', '.kube', '.docker', '.npmrc', '.netrc', '.pgpass', '.my.cnf'].map(
    (p) => `${CONTAINER.home}/${p}`,
  ),
  ...['.config/gcloud', '.terraform.d', '.vercel', '.config/op', '.bash_history'].map(
    (p) => `${CONTAINER.home}/${p}`,
  ),
  `${CONTAINER.home}/.claude/.credentials.json`,
  `${CONTAINER.home}/.claude.json`,
  `${CONTAINER.home}/.abe/logins`,
  `${CONTAINER.home}/${SYNC_DIR}`,
  SESSION_FILES,
  `${SOCKET_MOUNT}/${WORKSPACE_SOCKET}`,
  CONTAINER.tmuxDir,
] as const;

/** A path as a shell word. */
const word = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A box session's jail (ADR 0029: only environment access held), the wrapper Claude Code runs each
 * command line behind (`CLAUDE_CODE_SHELL_PREFIX`, `$1`): bubblewrap with the network shared
 * (outbound open; the container publishes no port, so nothing comes in), the root written as the
 * session's user may but what decides its reach (`JAIL_PLACEHOLDERS` in each of its trees there:
 * read-only, one missing over an empty mount point bound to `/dev/null`, so no command makes it),
 * its own pid namespace and `/proc` (no other process's environment), each of `BOX_HIDDEN` and of
 * `off` (the files of the environments off for agents: their Abe env files, the repo env files
 * feeding only them) that is there hidden (a folder under an empty tmpfs, a file under
 * `/dev/null`), the session sockets hidden but its own (`$ABE_SOCKET`'s folder: another session's
 * is its Reach to serve), and Claude Code's login unset before bwrap starts (pid 1 there: its
 * environ is readable inside). `trees`: `BOX_TREES` (a test's own folder stands in).
 */
export const boxJailScript = (
  o: {
    off?: readonly string[];
    trees?: readonly string[];
    /** Where `SYNC_LOCKED` is, and the clone its paths are in (a test's own folder stands in). */
    locked?: string;
    clone?: string;
  } = {},
): string =>
  [
    '#!/bin/sh',
    'cmd=$1',
    'set --',
    // what decides its reach stays as it is, whatever a command writes; a missing one is made by
    // none (a tree not there yet is none of its: `git worktree add` wants it empty)
    `for t in ${(o.trees ?? BOX_TREES).map(word).join(' ')}; do`,
    '  [ -d "$t" ] || continue',
    `  for f in ${JAIL_PLACEHOLDERS.map((f) => `"$t"/${word(f)}`).join(' ')}; do`,
    '    if [ -e "$f" ]; then set -- "$@" --ro-bind "$f" "$f"; else set -- "$@" --ro-bind /dev/null "$f"; fi',
    '  done',
    'done',
    // the team's files the Mac changed and synced (3.2.1, `SYNC_LOCKED`): read-only, the rest
    // of the team's the card's own
    `l=${word(o.locked ?? `${CONTAINER.home}/${SYNC_LOCKED}`)}`,
    `w=${word(o.clone ?? CONTAINER.workdir)}`,
    'if [ -f "$l" ]; then',
    '  while IFS= read -r p; do',
    '    case "$p" in \'\'|/*|..|../*|*/..|*/../*) continue;; esac',
    '    if [ -e "$w/$p" ]; then set -- "$@" --ro-bind "$w/$p" "$w/$p"; fi',
    '  done < "$l"',
    'fi',
    // after the reach files: an off environment's is hidden over its read-only bind
    `for p in ${[...BOX_HIDDEN, ...(o.off ?? [])].map(word).join(' ')}; do`,
    '  if [ -d "$p" ]; then set -- "$@" --tmpfs "$p"; elif [ -e "$p" ]; then set -- "$@" --ro-bind /dev/null "$p"; fi',
    'done',
    `own=$(dirname "\${ABE_SOCKET:-/nonexistent/x}")`,
    // Not only bwrap's child's: bwrap is pid 1 in the jail, its environ the command's to read.
    `unset ${CLAUDE_LOGIN}`,
    [
      'exec bwrap --die-with-parent --unshare-pid --unshare-ipc',
      '--bind / / --dev /dev --proc /proc',
      `"$@" --tmpfs ${word(`${SOCKET_MOUNT}/${SESSION_SOCKETS}`)} --bind-try "$own" "$own"`,
      '/bin/sh -c "$cmd"',
    ].join(' \\\n  '),
    '',
  ].join('\n');

/**
 * The workspace container's managed settings (`/etc/claude-code/managed-settings.json`, written
 * as root, so nothing in the session changes them):
 * - the only hooks and permission rules: no other settings file (a `.claude/settings.json` the
 *   agent writes, the session's own `--settings`) adds one, so the allow rules are here too;
 * - the hooks: `abe hook <event>` for every event, reaching the session's own socket;
 * - Claude Code's sandbox off, each command in Abe's jail (`boxJailScript`) and in no bubblewrap
 *   of Claude Code's (its credential scrub's forbids the jail's user namespace);
 * - what decides its reach (`BOX_REACH_FILES`) written by no file tool, as by no command;
 * - credential files denied to commands and file tools, the login variable unset for commands
 *   (gh's own login stays readable: the session's `gh` and `git push` work as the person);
 * - the other sockets denied: the workspace socket, every session's socket folder (a session's own
 *   is opened again by its `--settings`, `boxSessionSettings`) and the container's tmux server, so
 *   a command cannot type into its own terminal. Unix sockets are allowed as such (Linux cannot
 *   tell them apart by path); the filesystem rules decide which ones a command reaches;
 * - no command outside the sandbox: the Verification pack's scripts go through `abe run`, which
 *   the box's serve runs in the container as the script user (`CONTAINER.runUser`), so the app
 *   they start outlives the call, the browser reaches it, and it never reads the session's login;
 * - every sandboxed command runs without asking, whatever a repo says;
 * - the network: GitHub, npm, and AWS's STS and the Reach environments' regions;
 * - the main model: the coordinator's (`sessionModels`), lowered by `allowedModels`, and only
 *   those to pick.
 */
export const managedSettings = (o: {
  abe: string;
  allowedModels: readonly string[];
  /** The in-session `abe` commands (`inSessionRules`): `--settings`' own allow rules do not count. */
  allow: readonly string[];
  /** The models the Layers ask for (`models.*`); none: core's preferences. */
  models?: SessionModels;
  /** The Reach AWS profiles' regions. */
  awsRegions: readonly string[];
  /** The team's paths the Mac changed and synced at launch (`SessionSync.locked`), from the top. */
  locked?: readonly string[];
}): ClaudeSettings => {
  const sockets = [
    `${SOCKET_MOUNT}/${WORKSPACE_SOCKET}`,
    `${SOCKET_MOUNT}/${SESSION_SOCKETS}`,
    CONTAINER.tmuxDir,
  ];

  return {
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    ...hookSettings(o.abe),
    model: sessionModels(o.allowedModels, o.models).coordinator,
    availableModels: [...o.allowedModels],
    modelPicker: sessionModelPicker(o.allowedModels),
    permissions: {
      // every command without asking: its jail holds it, the deny rules still hold
      allow: [...o.allow, 'Bash'],
      deny: [
        // Not gh's hosts.yml: Claude Code turns a Read deny into a sandbox one too, and the
        // session's own gh (and git through it) needs its login.
        ...CREDENTIAL_FILES.flatMap((p) => [`Read(${p})`, `Read(${p}/**)`]),
        ...sockets.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]),
        'Read(//proc/*/environ)',
        ...SESSION_FILE_RULES,
        // what decides its reach, from the file tools too (its commands': the jail); an off
        // environment's files are its launch's (`accessRules`, on `BOX_TREES`)
        ...BOX_REACH_FILES.map((f) => `Edit(/${f})`),
        // the team's files the Mac changed (3.2.1), as its launch was told, and what a sync
        // keeps (the tokens, the keys, the list the jail reads): written by no file tool
        ...(o.locked ?? []).map((p) => `Edit(/${CONTAINER.workdir}/${p})`),
        `Edit(~/${SYNC_DIR}/**)`,
        ...PROJECT_SETTINGS_DENY,
        // gh works here (its login is readable), and a person merges, never an agent (#196).
        ...MERGE_DENY,
      ],
      disableBypassPermissionsMode: 'disable',
    },
    // Claude Code's sandbox off: each command runs in Abe's jail (`boxJailScript`, ADR 0029),
    // the network open, secrets and files held, the login unset. Not Claude Code's credential
    // scrub: on Linux it runs each command in a bubblewrap of its own that forbids further user
    // namespaces (`--disable-userns`), so the jail's bubblewrap inside it could not start.
    sandbox: { enabled: false },
    env: { [SHELL_PREFIX_ENV]: BOX_JAIL },
  };
};

/** One session's `--settings`: its own socket folder readable again inside the denied ones. */
export const boxSessionSettings = (id: string): ClaudeSettings => ({
  sandbox: { filesystem: { allowRead: [boxSessionDir(SOCKET_MOUNT, id)] } },
});

/**
 * The card's words the Mac sends a box with `abe session run --text`, with the launch's notes and
 * workflow: one value, so no text is ever read as a flag.
 */
export const CardText = z.object({
  title: z.string(),
  description: z.string().default(''),
  acceptanceCriteria: z.string().default(''),
  /** The card's comments, oldest first: the run's prompt carries the whole card. */
  comments: z.array(CardComment).default([]),
  /** The Launch note and the standing notes at launch (#347). */
  note: LaunchNote.nullable().default(null),
  standing: z.array(StandingNote).default([]),
  /** The card's type and tags: which workflow's `on:` takes it, as on the Mac. */
  type: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /** The workflow picked locally (`--workflow`, or by `on:` in its sources); null: by type and tags here. */
  workflow: RunWorkflow.nullable().default(null),
});
export type CardText = z.infer<typeof CardText>;

/** The person's login secrets in the tooling account's Secrets Manager (#55 makes and refreshes them). */
export const loginSecrets = (owner: string): { claude: string; github: string } => ({
  claude: `abe/${owner}/claude-token`,
  github: `abe/${owner}/github-token`,
});
