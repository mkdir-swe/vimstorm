/**
 * aws cut off for a Factory install until Logins checked an aws login: what its `abe run` starts,
 * and a local-mode card session, run with aws failing closed. Such a session is
 * refused `aws` itself (`AWS_OFF_DENY`); a repo script that calls aws finds no profile, no
 * credentials and no instance metadata (`awsOffEnv`). The install's own session is unjailed
 * (#71): its aws is the person's. Rules only: serve keeps the empty file and launches.
 */
import { type Install } from './install';

/** Why aws is off: no aws login is checked. */
export type AwsOff = 'unchecked';

/**
 * Whether aws is off for the install, and why; null: on (Logins checked aws ok).
 * No record: off.
 */
export const installAwsOff = (i: Pick<Install, 'logins'> | undefined): AwsOff | null => {
  return i?.logins?.find((l) => l.tool === 'aws')?.state === 'ok' ? null : 'unchecked';
};

/** The session's own rules: it never runs `aws`, nor reads aws's config and credentials. */
export const AWS_OFF_DENY: readonly string[] = ['Bash(aws:*)', 'Read(~/.aws/**)'];

/**
 * `~/.aws` (its config, credentials and SSO cache) kept from every local session's file tools,
 * whatever is enabled (ADR 0029): no session uses a profile there, prod's neither.
 */
export const AWS_HOME_DENY: readonly string[] = ['Read(~/.aws/**)', 'Edit(~/.aws/**)'];

/** aws's own folder under a home: the sandbox keeps a session's commands from reading it. */
export const awsHome = (home: string): string => `${home.replace(/\/+$/, '')}/.aws`;

/**
 * An environment with aws failing closed: every `AWS_*` name taken out, its config and
 * credentials files the empty one Abe keeps (`empty`), instance metadata off.
 */
export const awsOffEnv = (
  env: Readonly<Record<string, string>>,
  empty: string,
): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('AWS_'))),
  AWS_CONFIG_FILE: empty,
  AWS_SHARED_CREDENTIALS_FILE: empty,
  AWS_EC2_METADATA_DISABLED: 'true',
});

/**
 * An environment whose aws is only the short-lived keys handed to it (ADR 0029): every `AWS_*`
 * name of `env` taken out, `keys`' own (an enabled environment's, `awsSessionEnv`) put in, the
 * config and credentials files the empty one Abe keeps, instance metadata off. No profile of
 * `~/.aws` is reached, prod's neither.
 */
export const awsKeysOnlyEnv = (
  env: Readonly<Record<string, string>>,
  empty: string,
  keys: Readonly<Record<string, string>>,
): Record<string, string> => ({
  ...awsOffEnv(env, empty),
  ...Object.fromEntries(Object.entries(keys).filter(([name]) => name.startsWith('AWS_'))),
});
