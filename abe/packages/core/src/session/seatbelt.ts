/**
 * A local session's jail (ADR 0029): it holds environment access only, the person's credentials
 * and the environments that are off; everything else a command does is open. Every Bash command a
 * session runs goes through `CLAUDE_CODE_SHELL_PREFIX`, a wrapper that runs it under macOS's
 * Seatbelt (`sandbox-exec`) with the profile built here from the session's sandbox settings
 * (`sessionBoundary`'s lists):
 * - it reads none of the person's secrets (`HOME_SECRETS`), no Abe state but its own folder, no
 *   env file of an environment off for agents, and connects to no Unix socket under those but its
 *   own session's (a file-read deny does not hold a `connect`, tried): serve's, tmux's and other
 *   sessions' stay out, Docker's, a database's and Playwright's are reached;
 * - it writes anywhere but what decides its reach (`envReachFiles`: the repo's settings and yours,
 *   the Abe env files), Abe's own state, config and plugins, and the main checkout's git config
 *   and hooks (serve's git runs them unjailed), so no agent turns prod on for itself;
 * - no Keychain; Claude Code's own tokens unset (`jailWrapper`); any host outbound, raw TCP and
 *   ssh too.
 * Another process's environment is macOS's to hide (`kern.procargs2` gives a user's process no
 * other's, tried), and `ps`, setuid, never runs under Seatbelt; `lsof` does, so no process-info
 * rule here. Listening is not held: Seatbelt cannot tell a localhost bind from any other (inbound
 * is the Mac firewall's). Claude Code's own sandbox is off for such a session (it would hold the
 * network); its deny rules and Abe's hook fence still hold Claude's file tools. An install's
 * session has no jail (#71): it runs as the person's own Claude Code, with them there. Pure.
 */
import type { ClaudeSettings, PermissionMode } from './session';

/**
 * The person's secrets under `HOME` no session reads, its file tools nor its commands: keys and
 * logins that reach secured systems (ssh, aws, az, kube, registries, databases, clouds), Claude
 * Code's own config (its MCP servers' headers), shell histories, the Keychain, browser profiles.
 */
export const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.my.cnf',
  '.config/gcloud',
  '.terraform.d',
  '.vercel',
  '.config/op',
  '.claude.json',
  '.zsh_history',
  '.bash_history',
  '.zsh_sessions',
  '.local/share/fish/fish_history',
  'Library/Keychains',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware',
  'Library/Safari',
  'Library/Cookies',
] as const;

/** The secrets of `home` as absolute paths; `azureConfigDir` too when az keeps its login elsewhere. */
export const homeSecrets = (home: string, azureConfigDir?: string): string[] => [
  ...HOME_SECRETS.map((p) => `${home.replace(/\/+$/, '')}/${p}`),
  ...(azureConfigDir === undefined || azureConfigDir === '' ? [] : [azureConfigDir]),
];

/** The XPC services a command never looks up: the Keychain's. */
export const KEYCHAIN_SERVICES = [
  'com.apple.securityd',
  'com.apple.securityd.xpc',
  'com.apple.SecurityServer',
  'com.apple.security.agent',
  'com.apple.secd',
] as const;

/** A path as a profile's string. */
const quoted = (path: string) => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

/**
 * A path as Seatbelt's filter: itself and what is under it; a glob (`*` within a folder, `**` any
 * depth) as a regex.
 */
export const pathFilters = (path: string): string[] => {
  if (!path.includes('*')) return [`(literal ${quoted(path)})`, `(subpath ${quoted(path)})`];
  const re = path
    .split(/(\*\*\/?|\*)/)
    .map((part) => {
      if (part === '**/' || part === '**') return '(.*/)?';
      if (part === '*') return '[^/]*';

      return escapeRe(part);
    })
    .join('');

  return [`(regex ${quoted(`^${re}(/.*)?$`)})`];
};

const rule = (verb: 'allow' | 'deny', op: string, paths: readonly string[]): string[] =>
  paths.length === 0 ? [] : [`(${verb} ${op} ${paths.flatMap(pathFilters).join(' ')})`];

/** What a session's commands may do, as `seatbeltProfile` takes it. */
export type JailSpec = {
  /** Never written: what decides its reach, Abe's state, config and plugins. All else is. */
  denyWrite: readonly string[];
  /**
   * Never read, and no Unix socket under them reached: Abe's state, the person's secrets, Abe env
   * files of environments that are off.
   */
  denyRead: readonly string[];
  /** Read again inside `denyRead`: the session's own folder, Abe's `bin`. */
  allowRead: readonly string[];
  /** The Unix sockets under `denyRead` it may connect to: its own session's. */
  sockets: readonly string[];
};

/**
 * The Seatbelt profile a session's commands run under (later rules win): all allowed, writes and
 * the network too; never a write to `denyWrite`; reads all but `denyRead` (`allowRead` again inside
 * it); no Unix socket under `denyRead` but `sockets` (one rule per filter: a `remote` takes one,
 * tried); no Keychain.
 */
export const seatbeltProfile = (o: JailSpec): string =>
  [
    '(version 1)',
    '(allow default)',
    // listening stays open: Seatbelt's `(local ip "localhost:*")` takes a bind on any address too
    // (tried: 0.0.0.0, the LAN address, ::), so inbound from other machines is the Mac firewall's
    ...rule('deny', 'file-write*', o.denyWrite),
    ...rule('deny', 'file-read*', o.denyRead),
    ...rule('allow', 'file-read*', o.allowRead),
    ...o.denyRead
      .flatMap(pathFilters)
      .map((f) => `(deny network-outbound (remote unix-socket ${f}))`),
    ...o.sockets.map(
      (s) => `(allow network-outbound (remote unix-socket (path-literal ${quoted(s)})))`,
    ),
    `(deny mach-lookup ${KEYCHAIN_SERVICES.map((s) => `(global-name ${quoted(s)})`).join(' ')})`,
  ].join('\n');

/** The variable Claude Code runs each Bash command behind (code.claude.com/docs/en/env-vars). */
export const SHELL_PREFIX_ENV = 'CLAUDE_CODE_SHELL_PREFIX';

/**
 * The variable that strips credentials from the environments of what Claude Code starts (its
 * Bash commands, hooks, stdio MCP servers); GitHub tokens stay (code.claude.com/docs/en/env-vars).
 * Set, it also starts Claude Code in `default` mode whatever its settings say (`startingMode`).
 */
export const SUBPROCESS_SCRUB_ENV = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB';

/**
 * The mode Claude Code starts a session in: its settings' `defaultMode`, but `default` whenever
 * `SUBPROCESS_SCRUB_ENV` is on ("Permission mode forced to default", Claude Code 2.1). None: the
 * person's own.
 */
export const startingMode = (
  settings: ClaudeSettings,
  env: Readonly<Record<string, string | undefined>>,
): PermissionMode | undefined =>
  /^(1|true|yes|on)$/i.test((env[SUBPROCESS_SCRUB_ENV] ?? '').trim())
    ? 'default'
    : settings.permissions?.defaultMode;

/**
 * A local session's environment with its jail: every command line through `wrapper`. No
 * `SUBPROCESS_SCRUB_ENV`: it would start the session in `default` mode, a Factory run's `auto`
 * lost, and the environment is `sessionEnv`'s already, with no credential of Claude Code's.
 */
export const jailEnv = (
  env: Readonly<Record<string, string>>,
  wrapper: string,
): Record<string, string> => ({ ...env, [SHELL_PREFIX_ENV]: wrapper });

/** macOS's sandbox runner. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * The wrapper script `SHELL_PREFIX_ENV` names: Claude Code hands it each command line as one
 * argument (`$1`, its whole shell invocation), run again under `profile` (a file) by the shell it
 * is written for: the line sources Claude Code's snapshot of the person's shell
 * (`snapshot-zsh-*.sh`, zsh-only code in it), which `/bin/sh` dies on. That shell is the
 * person's `SHELL` (`sessionEnv`) when it is the snapshot's, else the system's of that name; a
 * line with no snapshot runs in `SHELL` when it is zsh or bash, else `/bin/sh`. Claude Code's own
 * tokens (`CLAUDE_CODE_*_TOKEN`: its messaging socket's, an OAuth login's) are unset first: no
 * command needs one, and `SUBPROCESS_SCRUB_ENV`, which would strip them, stays off (`jailEnv`).
 */
export const jailWrapper = (profile: string): string =>
  [
    '#!/bin/sh',
    "for name in $(/usr/bin/env | /usr/bin/sed -n 's/^\\(CLAUDE_CODE_[A-Za-z0-9_]*_TOKEN\\)=.*/\\1/p'); do",
    '  unset "$name"',
    'done',
    'shell=${SHELL:-/bin/sh}',
    'case "$shell" in */zsh | */bash) ;; *) shell=/bin/sh ;; esac',
    'case "$1" in',
    '*/shell-snapshots/snapshot-zsh-*) case "$shell" in */zsh) ;; *) shell=/bin/zsh ;; esac ;;',
    '*/shell-snapshots/snapshot-bash-*) case "$shell" in */bash) ;; *) shell=/bin/bash ;; esac ;;',
    'esac',
    `exec ${SANDBOX_EXEC} -f ${quoted(profile)} "$shell" -c "$1"`,
    '',
  ].join('\n');

/**
 * A local session's settings and jail: its sandbox's filesystem and socket lists (the person's
 * secrets among them, `sessionBoundary`) as the profile its commands run under, Claude Code's own
 * sandbox off, every Bash command allowed without asking as the sandbox let it (the deny rules and
 * the hooks still hold). None: a session with no sandbox of ours (a box's).
 */
export const jailed = (
  settings: ClaudeSettings,
): { settings: ClaudeSettings; profile: string } | undefined => {
  const sandbox = settings.sandbox;
  const fs = sandbox?.filesystem;

  if (sandbox?.enabled !== true || fs === undefined) return undefined;
  const profile = seatbeltProfile({
    denyWrite: fs.denyWrite ?? [],
    denyRead: fs.denyRead ?? [],
    allowRead: fs.allowRead ?? [],
    sockets: sandbox.network?.allowUnixSockets ?? [],
  });

  return {
    settings: {
      ...settings,
      sandbox: { enabled: false },
      permissions: {
        ...settings.permissions,
        allow: [...new Set([...(settings.permissions?.allow ?? []), 'Bash'])],
      },
    },
    profile,
  };
};
