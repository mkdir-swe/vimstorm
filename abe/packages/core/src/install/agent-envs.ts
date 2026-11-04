/**
 * Agents reach only the enabled environments (ADR 0029): per checkout the person turns dev, test
 * and prod on or off for agents (`agents.dev`, `agents.test`, `agents.prod`; dev and test on, prod
 * off). An enabled environment is reached in full, read and write; one that is off is not reached
 * at all, reads included, by no parsing of commands: its Abe env file is not linked into a card's
 * worktree and is denied to the session, its aws profile's keys are never handed on: it is
 * kept out as any secret is (the network is open: no secret, no reach). This module says
 * what that makes of a session: its access rules (`accessRules`), the files it never reads
 * (`offRepoEnvFiles`), and what it is told (`agentEnvsLine`). Pure.
 */
import { ABE_ENVS, type AbeEnv, abeEnvFile } from './credentials';

/** The setting that turns `env` on for agents in a checkout. */
export const agentEnvKey = (env: AbeEnv) => `agents.${env}` as const;

/** Each environment on for agents by default: dev and test, never prod. */
export const AGENT_ENVS_DEFAULT: Readonly<Record<AbeEnv, boolean>> = {
  dev: true,
  test: true,
  prod: false,
};

/**
 * The environments one session reaches: the repo's enabled ones, and prod when the person turned
 * it on at that session's launch, for it alone.
 */
export const withOwnReach = (enabled: readonly AbeEnv[], prodOn: boolean): readonly AbeEnv[] =>
  prodOn && !enabled.includes('prod') ? [...enabled, 'prod'] : enabled;

/** What a check or `abe run` in an environment that is off is refused with. */
export const envNotEnabled = (env: AbeEnv): string =>
  `${env} isn't enabled for agents in this repo: the person turns it on in Settings › Agents › Environments (abe settings set ${agentEnvKey(env)} true --mine); it applies to the next session`;

/**
 * Commands that print a secret's value into the transcript: a credential handed out. Denied in
 * every session, whatever the environment.
 */
export const SECRET_OUTPUT_DENY = [
  'Bash(gh auth token*)',
  'Bash(aws configure export-credentials*)',
  'Bash(aws configure get *aws_secret_access_key*)',
  'Bash(aws configure get *aws_session_token*)',
  'Bash(aws sts get-session-token*)',
] as const;

/** A server's name as Claude Code writes it in a tool's name. */
const serverName = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, '_');

/** `path` as a Read / Edit rule's absolute path (`//` + the path without its leading slash). */
const rulePath = (path: string) => `/${path}`;

/**
 * The repo env files (from the top) that feed only environments off for agents, or that the
 * install was not sure of and the person did not place yet: read by no session. `mapping` is each
 * file's placement (`envPlacement`: `abe.yaml`'s worktree groups first, ADR 0040, then the
 * install's env map); one in an `all` group (`always`) is every run's, never held.
 */
export const offRepoEnvFiles = (
  mapping: readonly {
    path: string;
    to: readonly AbeEnv[] | 'not-used' | 'not-sure';
    always?: boolean;
  }[],
  enabled: readonly AbeEnv[],
): string[] =>
  mapping
    .filter((f) => {
      const to = f.to;

      if (f.always === true) return false;

      return to === 'not-sure' || (to !== 'not-used' && to.every((e) => !enabled.includes(e)));
    })
    .map((f) => f.path);

/**
 * A session's access rules (ADR 0029): every tool of every added MCP server (`servers`) allowed,
 * writes too; the only denies the Abe env files of the environments that are off and the repo env
 * files feeding only those (`repoFiles`, from the top), in each tree it works in (the main
 * checkout, its worktree; a box's as its container has them), every Abe env file of another
 * checkout (`others`), for its file tools (read, edit, write) and its shell (`denyRead`: the
 * sandbox's, or a box's jail), and secret output. No per-tool MCP deny.
 */
export const accessRules = (o: {
  servers: readonly string[];
  enabled: readonly AbeEnv[];
  /** The main checkout and the session's worktree, real paths (a box's: its container's). */
  trees: readonly string[];
  repoFiles?: readonly string[];
  /** Other checkouts the person's Layer knows, real paths. */
  others?: readonly string[];
}): { allow: string[]; deny: string[]; denyRead: string[] } => {
  const own = [
    ...ABE_ENVS.filter((e) => !o.enabled.includes(e)).map(abeEnvFile),
    ...(o.repoFiles ?? []),
  ];
  const files = [
    ...o.trees.flatMap((t) => own.map((f) => `${t.replace(/\/+$/, '')}/${f}`)),
    ...(o.others ?? [])
      .filter((c) => !o.trees.includes(c))
      .flatMap((c) => ABE_ENVS.map((e) => `${c.replace(/\/+$/, '')}/${abeEnvFile(e)}`)),
  ];

  return {
    allow: [...new Set(o.servers.map((s) => `mcp__${serverName(s)}__*`))],
    deny: [
      ...new Set([
        ...files.flatMap((f) => [`Read(${rulePath(f)})`, `Edit(${rulePath(f)})`]),
        ...SECRET_OUTPUT_DENY,
      ]),
    ],
    denyRead: [...new Set(files)],
  };
};

/** What a session is told of the environments it reaches. */
export const agentEnvsLine = (enabled: readonly AbeEnv[]): string => {
  const off = ABE_ENVS.filter((e) => !enabled.includes(e));
  const one = off.length === 1;
  const reach = enabled.length === 0 ? 'no environment' : enabled.join(' and ');

  return `Environments: this session reaches ${reach}, read and write. aws only through abe run and the checks, with an enabled environment's short-lived keys: no profile of ~/.aws is reached here.${
    off.length === 0
      ? ''
      : ` ${off.join(' and ')} ${one ? 'is' : 'are'} off for agents in this repo and unreachable by design (no env file, no aws keys, no secret of its systems): never look for a way around. Say what needs ${one ? 'it' : 'them'}; the person runs it, or turns ${one ? 'it' : 'them'} on for a next session.`
  }`;
};
