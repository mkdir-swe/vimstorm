/** The install's rows of the command table: `abe install`, `check` and `tools check`. */
import { command } from '../command';
import { CheckFilesData, checkFilesText } from './check-files';
import { INSTALL_PARTS, InstallResetData, installResetText } from './install';
import { InstallCheckData, installCheckText } from './install-check';
import { REPO_KINDS } from './install-kind';
import {
  InstallCheckedData,
  installCheckedText,
  installCheckFailed,
  InstallGateData,
  installGateText,
  InstallView,
  installViewText,
} from './install-view';
import { InstallSourcesData, installSourcesText } from './install-source-list';
import { REPO_PATH } from '../layer/settings/places';
import { SOURCE_TRANSPORTS } from './source-servers';
import { SourcesData, sourcesText } from './source-status';
import { ToolsCheckData, toolsCheckText } from './tools';

const INSTALL_REPO = {
  kind: 'flag',
  type: 'string',
  summary: 'the main checkout, relative to where abe runs (default: here)',
} as const;

export const INSTALL_COMMANDS = {
  'tools check': command({
    noun: 'tools',
    verb: 'check',
    summary:
      "the tools Abe runs (node, tmux, docker, az, gh, claude, git, rg, aws) as abe serve finds them on its PATH: each one's version, or not found, and the fix",
    inSession: false,
    args: {},
    result: ToolsCheckData,
    text: toolsCheckText,
  }),
  install: command({
    noun: 'install',
    summary:
      "set up the repo for the Factory (#22, #71): open the repo's Abe chat in this main checkout (unjailed, the running one or a new one), which follows /abe:install while the install is not Done. A repo with an abe.yaml already is a join: your own parts alone. Its id printed",
    inSession: false,
    args: { repo: INSTALL_REPO },
    result: InstallView,
    text: installViewText,
  }),
  'install reset': command({
    noun: 'install',
    verb: 'reset',
    summary:
      "start the repo's install clean: its session stopped, .abe/'s untracked and ignored files deleted (your env files, your settings for the repo; what git tracks there stays) and its record moved aside to a dated folder, so abe install starts it again. abe.yaml and .claude/skills/, the team's, are never touched",
    inSession: false,
    args: {
      repo: INSTALL_REPO,
    },
    result: InstallResetData,
    text: installResetText,
  }),
  'install status': command({
    noun: 'install',
    verb: 'status',
    summary:
      "the repo's install: whether it is a join, its session, and each part's last check (pass, fail, warn or todo) with its line; done once every required part passes or warns",
    inSession: true,
    args: { repo: INSTALL_REPO },
    result: InstallView,
    text: installViewText,
  }),
  'install logins': command({
    noun: 'install',
    verb: 'logins',
    summary:
      'check the logins the repo needs (before anything remote); one missing: abe login <tool> in Terminal',
    inSession: true,
    args: { repo: INSTALL_REPO },
    result: InstallView,
    text: installViewText,
  }),
  'install gate': command({
    noun: 'install',
    verb: 'gate',
    summary:
      "the gate: the app answers on localhost and every backend in the env files is local, test or a sandbox, never prod; recorded for the Verify check; --before-run judges what start loads before abe run start (which asks it itself); --cannot-run when the person chose that the app can't run here (Verify passes without the app, saying what was not run)",
    inSession: true,
    args: {
      url: {
        kind: 'flag',
        type: 'string',
        summary: "the URL the repo's start script printed (abe run start)",
      },
      beforeRun: {
        kind: 'flag',
        type: 'boolean',
        summary: 'instead of --url: what start loads, judged before the app starts',
      },
      cannotRun: {
        kind: 'flag',
        type: 'string',
        summary:
          "instead of --url: why the app can't run here, as the person chose (a login it needs, secrets only the person has)",
      },
      testHost: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          "a host the person says is a test backend, only when it truly is one: written to abe.yaml's gate.testHosts",
      },
      readOnlyHost: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          "a prod host the person says the app only reads from (read-only use): written to abe.yaml's gate.readOnlyHosts",
      },
      notUsed: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          '"<key or env file>: <how you know>": one the app never uses, with the evidence: written to abe.yaml\'s env.notUsed',
      },
      repo: INSTALL_REPO,
    },
    result: InstallGateData,
    text: installGateText,
  }),
  'install sources': command({
    noun: 'install',
    verb: 'sources',
    summary: `the team's sources (ADR 0031): the repo's ${REPO_PATH} sources:, then the MCP servers your Claude Code has for the main checkout (its local scope, then your user scope) that sources: does not define, each marked found: local-scope or user-scope for the install to offer (abe install source <name> copies one in). Names and definitions only, never a token`,
    inSession: true,
    args: { repo: INSTALL_REPO },
    result: InstallSourcesData,
    text: installSourcesText,
  }),
  'install source': command({
    noun: 'install',
    verb: 'source',
    summary: `add a source to the repo's ${REPO_PATH} sources: (ADR 0031): a server your Claude Code has (abe install sources lists them), its definition copied as it is so your sign-in is reused, one Read found on the server known for it, or a new one by its URL; or skip one Read found (--skip). Never a secret: a header or env value is refused unless a \${VAR} reference. Never claude mcp add or remove. By you, or the install's session; never another session`,
    inSession: true,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          "its name (a server abe install sources lists, or a new one with --url), or its MCP server's URL: sentry, https://mcp.sentry.dev/mcp",
      },
      url: {
        kind: 'flag',
        type: 'string',
        summary:
          "a new server's URL: https (or http on localhost); none: a server your Claude Code has, the one sources: defines, or the server known for a source Read found",
      },
      skip: {
        kind: 'flag',
        type: 'boolean',
        summary: 'a source Read found, skipped: no session reads it',
      },
      transport: {
        kind: 'flag',
        type: 'string',
        values: SOURCE_TRANSPORTS,
        summary: "a new server's transport: http (the default), sse, or stdio with --command",
      },
      command: {
        kind: 'flag',
        type: 'string',
        summary: 'a new stdio server: the command that starts it',
      },
      arg: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: "a new stdio server: one of its command's arguments, in order",
      },
      env: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          'a new stdio server: an env key it needs (an API user, a token), written as a ${KEY} reference; its value is yours, in .abe/sources.env',
      },
      header: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          'a new http or sse server: a header it needs, Name=VAR, written as a ${VAR} reference; its value is yours, in .abe/sources.env',
      },
      repo: INSTALL_REPO,
    },
    result: InstallSourcesData,
    text: installSourcesText,
  }),
  'source status': command({
    noun: 'source',
    verb: 'status',
    summary:
      "this checkout's sources (the repo's sources:, and those its install added): each one's MCP server, its state, its one read once serve signed it in, and whether Sign in would help. Settings › Logins & tools reads it",
    inSession: true,
    args: { repo: INSTALL_REPO },
    result: SourcesData,
    text: sourcesText,
  }),
  'source sign-in': command({
    noun: 'source',
    verb: 'sign-in',
    summary:
      "sign in to a source (Sign in on its row in Settings, or the install's session for you): serve runs its sign-in in your browser, outside any sandbox, and checks one read; an added source's, the install's session is resumed on it. You go on meanwhile. By you or the install's session: another is told where to sign in",
    inSession: true,
    args: {
      source: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the source, as the repo names it: sentry, datadog',
      },
      repo: INSTALL_REPO,
    },
    result: SourcesData,
    text: sourcesText,
  }),
  'install env-profile': command({
    noun: 'install',
    verb: 'env-profile',
    summary:
      "the aws profile an environment's checks and abe run get short-lived keys from (any of this machine's), or none. Kept in your Layer for this checkout; a profile by you or the install's session, none any session may set",
    inSession: true,
    args: {
      env: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the environment: dev, test or prod',
      },
      profile: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the aws profile, or none',
      },
      repo: INSTALL_REPO,
    },
    result: InstallView,
    text: installViewText,
  }),
  'install checks-env': command({
    noun: 'install',
    verb: 'checks-env',
    summary:
      "the environment the checks run with (its Abe env file and aws profile's keys; dev when none is said): judged from the repo's scripts, CI and README and recorded by the install's session with --why, or picked by you (another session never changes yours); written to abe.yaml's checksEnv for the team (ADR 0040)",
    inSession: true,
    args: {
      env: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the environment: dev or test',
      },
      why: {
        kind: 'flag',
        type: 'string',
        summary: 'the evidence: the script, CI job or README line, cited',
      },
      repo: INSTALL_REPO,
    },
    result: InstallView,
    text: installViewText,
  }),
  'install env-map': command({
    noun: 'install',
    verb: 'env-map',
    summary:
      "which of the repo's env files feeds which environment, judged from evidence (scripts, README and CLAUDE.md, CI, key names, file names, in that order) and kept as a decision; serve writes it into abe.yaml for the team (ADR 0040: each placed file in worktree.link's group per environment, all for every one; not-used ones in env.notUsed), then the three Abe env files (kept out of git), prefilled the way the repo's loader would. Each file once, in load order (a base before its overlay); one you can't place is not-sure, to ask the person. Never a value",
    inSession: true,
    args: {
      file: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          '"<file> -> <dev,test,prod | not-used | not-sure>: <evidence or why>", the file from the top: backend/.env -> dev,test,prod: backend/package.json:11 dotenv -e .env -c dev',
      },
      ci: {
        kind: 'flag',
        type: 'string',
        summary:
          "where CI keeps the environments no env file feeds (its file and line): each such Abe env file names CI's keys",
      },
      ciKey: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary: 'a key CI sets for the environments, by its name, never a value (with --ci)',
      },
      repo: INSTALL_REPO,
    },
    result: InstallView,
    text: installViewText,
  }),
  'install connection': command({
    noun: 'install',
    verb: 'connection',
    summary:
      'read again, live, what the install set up (the board, GitHub, the cloud, each source, each environment), as the Logins, Board and Sources checks read it',
    inSession: true,
    args: {
      repo: INSTALL_REPO,
    },
    result: InstallView,
    text: installViewText,
  }),
  'install kind': command({
    noun: 'install',
    verb: 'kind',
    summary:
      "say the repo's kind when Read read it wrong (asked of the person first), for the whole repo or one part of a monorepo (--part): written to abe.yaml's kind: for the team (ADR 0040), Read again with it over the files'; what Verify checks follows it",
    inSession: true,
    args: {
      kind: {
        kind: 'positional',
        type: 'string',
        values: REPO_KINDS,
        required: true,
        summary: REPO_KINDS.join(', '),
      },
      part: {
        kind: 'flag',
        type: 'string',
        summary:
          "a monorepo's part, its folder from the top (apps/web, . the top): that part's kind alone",
      },
      repo: INSTALL_REPO,
    },
    result: InstallView,
    text: installViewText,
  }),
  'install check': command({
    noun: 'install',
    verb: 'check',
    summary:
      'check a part of the install now, as serve: from the files, the settings and live reads (Logins, Board and Sources read the connection live; Checks and Verify run the checks in checks:, Verify judges the gate), recording pass, fail or warn with one line, and when. Exit 1 when one it checked fails (a warning exits 0), the answer still ok. The install is Done once every required part passes or warns',
    inSession: true,
    args: {
      part: {
        kind: 'positional',
        type: 'string',
        values: INSTALL_PARTS,
        summary: INSTALL_PARTS.join(', '),
      },
      all: { kind: 'flag', type: 'boolean', summary: 'every part, in order' },
      repo: INSTALL_REPO,
    },
    result: InstallCheckedData,
    text: installCheckedText,
    fails: installCheckFailed,
  }),
  'install try': command({
    noun: 'install',
    verb: 'try',
    summary:
      "run a check as serve: in the main checkout, with the Abe env file's values and the aws profile's short-lived keys of the checks' environment (as abe run --env gets them; dev when none), in dev the install session's own database over the file's DATABASE_URL, CI's NODE_OPTIONS and a timeout; answers pass or fail, its exit and the tail of what it said, every value redacted. A check in checks: by its name or --all, or one not written yet with --command",
    inSession: true,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        summary: "a check in abe.yaml's checks:, by its name",
      },
      all: { kind: 'flag', type: 'boolean', summary: 'every check in checks:' },
      command: {
        kind: 'flag',
        type: 'string',
        summary:
          'instead: a command not in checks: yet (one CI runs, or a package script), tried the same way before you write it',
      },
      repo: INSTALL_REPO,
    },
    result: InstallCheckData,
    text: installCheckText,
  }),
  'check json': command({
    noun: 'check',
    verb: 'json',
    summary:
      "parse files as JSON, read-only, with Abe's own reader (a repo's static check, no tool needed): exit 1 at the first that does not parse, its file:line:column",
    inSession: true,
    args: {
      files: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the files, from where it is typed',
      },
    },
    result: CheckFilesData,
    text: checkFilesText,
  }),
  'check yaml': command({
    noun: 'check',
    verb: 'yaml',
    summary:
      "parse files as YAML (every document in each), read-only, with Abe's own parser (a repo's static check, no tool needed): exit 1 at the first that does not parse, its file:line:column",
    inSession: true,
    args: {
      files: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the files, from where it is typed',
      },
    },
    result: CheckFilesData,
    text: checkFilesText,
  }),
};
