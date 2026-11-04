/**
 * AWS through the `aws` CLI: `sts assume-role` for Reach's credentials and `secretsmanager
 * get-secret-value` for the secrets behind database names. It runs on serve's own credentials (the
 * box's role, or the person's SSO on the Mac). IO only; which role and why is core's.
 */
import {
  type Answered,
  type Aws,
  type AwsCredentials,
  isReachProfile,
  type Secrets,
} from '@abe/core';
import { z } from 'zod';
import { type Env } from '../mac/locations';

export type AwsCli = (args: readonly string[]) => Promise<Answered<string>>;

/** The names `aws` gets from `env`, besides every `AWS_*`: nothing of serve's own secrets or GitHub's. */
const AWS_KEPT = new Set(['HOME', 'PATH', 'LANG', 'TMPDIR']);

/**
 * What `aws` runs with: `env`'s `HOME`, `PATH`, `LANG`, `TMPDIR` and `AWS_*` only, less a Reach
 * profile (it would make `aws` call `abe reach creds` from inside itself), never paging or prompting.
 */
export const awsEnv = (env: Env): Record<string, string> => {
  const kept: Record<string, string> = {};

  for (const [name, value] of Object.entries(env))
    if (
      value !== undefined &&
      (AWS_KEPT.has(name) || name.startsWith('AWS_')) &&
      !(name === 'AWS_PROFILE' && isReachProfile(value))
    )
      kept[name] = value;

  return { ...kept, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
};

const TIMEOUT_MS = 30_000;

export const awsRunner = (env: Env, timeoutMs = TIMEOUT_MS): AwsCli => {
  const childEnv = awsEnv(env);

  return async (args) => {
    const bin = Bun.which('aws', { PATH: childEnv.PATH ?? '' });

    if (bin === null)
      return {
        ok: false,
        error: { code: 'aws-failed', message: 'aws is not installed (not on PATH)' },
      };
    const child = Bun.spawn([bin, ...args], {
      env: childEnv,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const late = { killed: false };
    const timer = setTimeout(() => {
      late.killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => {
      clearTimeout(timer);
    });

    if (late.killed)
      return {
        ok: false,
        error: {
          code: 'aws-failed',
          message: `aws ${args.slice(0, 2).join(' ')} gave no answer in ${timeoutMs / 1000} s`,
        },
      };
    if (exit === 0) return { ok: true, data: stdout };
    const message = stderr.trim() === '' ? `aws exited ${exit}` : stderr.trim();

    return { ok: false, error: { code: 'aws-failed', message } };
  };
};

const region = (r: string | null) => (r === null ? [] : ['--region', r]);

const Assumed = z.object({
  Credentials: z.object({
    AccessKeyId: z.string().min(1),
    SecretAccessKey: z.string().min(1),
    SessionToken: z.string().min(1),
    Expiration: z.string().min(1),
  }),
});

const readCredentials = (stdout: string): Answered<AwsCredentials> => {
  let json: unknown;

  try {
    json = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error: { code: 'aws-failed', message: 'aws sts assume-role answered no JSON' },
    };
  }
  const read = Assumed.safeParse(json);

  if (!read.success)
    return {
      ok: false,
      error: {
        code: 'aws-failed',
        message: `aws sts assume-role answered a shape Abe does not read`,
      },
    };
  const c = read.data.Credentials;

  return {
    ok: true,
    data: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    },
  };
};

export const awsPort = (aws: AwsCli): Aws => ({
  assumeRole: async (input) => {
    const out = await aws([
      'sts',
      'assume-role',
      '--role-arn',
      input.roleArn,
      '--role-session-name',
      input.sessionName,
      '--source-identity',
      input.sourceIdentity,
      '--duration-seconds',
      String(input.durationSeconds),
      ...region(input.region),
      '--output',
      'json',
    ]);

    return out.ok ? readCredentials(out.data) : out;
  },
});

export const secretsPort = (aws: AwsCli): Secrets => ({
  read: async ({ secret, region: r }) => {
    const out = await aws([
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      secret,
      '--query',
      'SecretString',
      ...region(r),
      '--output',
      'text',
    ]);

    if (!out.ok)
      return {
        ok: false,
        error: { code: 'secret-unreadable', message: `${secret}: ${out.error.message}` },
      };

    return { ok: true, data: out.data.replace(/\n$/, '') };
  },
});

/** AWS and the secrets behind it, from serve's environment. */
export const awsFrom = (env: Env): { aws: Aws; secrets: Secrets } => {
  const run = awsRunner(env);

  return { aws: awsPort(run), secrets: secretsPort(run) };
};
