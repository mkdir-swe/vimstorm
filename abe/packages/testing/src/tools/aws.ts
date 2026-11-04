/**
 * A fake `aws` on disk, built on `fakeTool`. It prints STS's and Secrets Manager's answers as the
 * CLI does and keeps each call, so a test reads the role, SourceIdentity and duration of every
 * AssumeRole made.
 */
import { type FakeTool, fakeTool, type ToolAnswer, type ToolCall } from './tool';

export type FakeAws = FakeTool;

/** What `aws` says for a call it has no answer for, STS's own access denied. */
export const ACCESS_DENIED: ToolAnswer = {
  stderr:
    'An error occurred (AccessDenied) when calling the operation: this fake aws has no answer',
  exit: 254,
};

export const fakeAws = (answers: readonly (readonly [string, ToolAnswer])[] = []): FakeAws =>
  fakeTool('aws', ACCESS_DENIED, answers);

/** `aws sts assume-role --output json`, as the CLI prints it. */
export const stsAssumed = (o: { key?: string; expiration?: string } = {}) => ({
  Credentials: {
    AccessKeyId: o.key ?? 'ASIAFAKEFAKEFAKE0001',
    SecretAccessKey: 'fake-secret-access-key',
    SessionToken: 'fake-session-token',
    Expiration: o.expiration ?? '2099-01-01T00:00:00+00:00',
  },
  AssumedRoleUser: {
    AssumedRoleId: 'AROAFAKE:abe-octocat',
    Arn: 'arn:aws:sts::111111111111:assumed-role/abe-read/abe-octocat',
  },
  SourceIdentity: 'octocat',
});

/** A secret's value as `get-secret-value --query SecretString --output text` prints it. */
export const secretText = (value: string): ToolAnswer => ({ stdout: `${value}\n` });

export type AssumeRole = {
  role: string;
  sourceIdentity: string;
  duration: number;
  sessionName: string;
  region: string | null;
};

const flag = (argv: readonly string[], name: string) => {
  const i = argv.indexOf(name);

  return i === -1 ? undefined : argv[i + 1];
};

/** Every `sts assume-role` among `calls`, read from its argv. */
export const assumedRoles = (calls: readonly ToolCall[]): AssumeRole[] =>
  calls
    .filter((c) => c.argv[0] === 'sts' && c.argv[1] === 'assume-role')
    .map((c) => ({
      role: flag(c.argv, '--role-arn') ?? '',
      sourceIdentity: flag(c.argv, '--source-identity') ?? '',
      duration: Number(flag(c.argv, '--duration-seconds')),
      sessionName: flag(c.argv, '--role-session-name') ?? '',
      region: flag(c.argv, '--region') ?? null,
    }));
