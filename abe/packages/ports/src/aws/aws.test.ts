/**
 * The AWS port's one AssumeRole against a fake `aws` (#54): the exact `sts assume-role` a box's
 * `serve` runs for `abe reach creds`, its answer read, and AWS's refusals handed on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assumedRoles, type FakeAws, fakeAws, stsAssumed } from '@abe/testing';
import { awsPort, awsRunner } from './aws';

const READ = 'arn:aws:iam::111111111111:role/abe-read';

const fakes: FakeAws[] = [];

const port = (aws: FakeAws, env: Record<string, string> = {}) => {
  fakes.push(aws);

  return awsPort(awsRunner({ PATH: aws.path, ...env }));
};

afterEach(() => {
  for (const f of fakes.splice(0)) f.remove();
});

const asOwner = {
  roleArn: READ,
  sessionName: 'abe-ada',
  sourceIdentity: 'ada',
  durationSeconds: 3600,
  region: 'eu-west-1',
};

describe('assumeRole', () => {
  test('one sts assume-role as the owner: role, session, SourceIdentity, an hour, the region', async () => {
    const aws = fakeAws([['sts assume-role', { json: stsAssumed({ key: 'ASIAOWNER' }) }]]);

    expect(await port(aws).assumeRole(asOwner)).toEqual({
      ok: true,
      data: {
        accessKeyId: 'ASIAOWNER',
        secretAccessKey: 'fake-secret-access-key',
        sessionToken: 'fake-session-token',
        expiration: '2099-01-01T00:00:00+00:00',
      },
    });
    expect(aws.calls().map((c) => c.argv)).toEqual([
      [
        'sts',
        'assume-role',
        '--role-arn',
        READ,
        '--role-session-name',
        'abe-ada',
        '--source-identity',
        'ada',
        '--duration-seconds',
        '3600',
        '--region',
        'eu-west-1',
        '--output',
        'json',
      ],
    ]);
    expect(assumedRoles(aws.calls())).toEqual([
      {
        role: READ,
        sourceIdentity: 'ada',
        duration: 3600,
        sessionName: 'abe-ada',
        region: 'eu-west-1',
      },
    ]);
  });

  test('an environment with no region: no --region, the CLI picks its own', async () => {
    const aws = fakeAws([['sts assume-role', { json: stsAssumed() }]]);

    expect((await port(aws).assumeRole({ ...asOwner, region: null })).ok).toBe(true);
    expect(aws.calls()[0]?.argv).not.toContain('--region');
  });

  test("AWS's refusal (another SourceIdentity) is aws-failed with AWS's own words", async () => {
    const denied =
      'An error occurred (AccessDenied) when calling the AssumeRole operation: User: ' +
      'arn:aws:sts::000000000000:assumed-role/abe-box-ada-a1/i-0 is not authorized to ' +
      `perform: sts:SetSourceIdentity on resource: ${READ}`;
    const aws = fakeAws([['--source-identity other', { stderr: denied, exit: 254 }]]);

    expect(await port(aws).assumeRole({ ...asOwner, sourceIdentity: 'other' })).toEqual({
      ok: false,
      error: { code: 'aws-failed', message: denied },
    });
  });

  test('an answer Abe does not read is a refusal, never credentials', async () => {
    const aws = fakeAws([['sts assume-role', { json: { Credentials: { AccessKeyId: 'A' } } }]]);
    const out = await port(aws).assumeRole(asOwner);

    expect(out).toMatchObject({ ok: false, error: { code: 'aws-failed' } });
  });

  test('a Reach profile in serve’s own env is not handed to aws (it would call abe reach creds)', async () => {
    const aws = fakeAws([['sts assume-role', { json: stsAssumed() }]]);

    await port(aws, { AWS_PROFILE: 'abe-read-test' }).assumeRole(asOwner);
    const env = aws.calls()[0]?.env ?? {};

    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_PAGER).toBe('');
  });

  test('any other profile is kept: on the Mac, the person’s SSO', async () => {
    const aws = fakeAws([['sts assume-role', { json: stsAssumed() }]]);

    await port(aws, { AWS_PROFILE: 'abe-tooling' }).assumeRole(asOwner);
    expect(aws.calls()[0]?.env.AWS_PROFILE).toBe('abe-tooling');
  });

  test('only HOME, PATH, AWS_*, LANG and TMPDIR reach aws: never serve’s secrets or a GitHub token', async () => {
    const aws = fakeAws([['sts assume-role', { json: stsAssumed() }]]);

    await port(aws, {
      HOME: '/home/abe',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/abe',
      AWS_PROFILE: 'abe-tooling',
      AWS_REGION: 'eu-west-1',
      ABE_LOGINS_SECRET: 'never-handed',
      GH_TOKEN: 'never-handed',
      GITHUB_TOKEN: 'never-handed',
      DATABASE_URL: 'never-handed',
    }).assumeRole(asOwner);
    const env = aws.calls()[0]?.env ?? {};

    expect(env).toMatchObject({
      HOME: '/home/abe',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/abe',
      AWS_PROFILE: 'abe-tooling',
      AWS_REGION: 'eu-west-1',
    });
    expect(Object.values(env)).not.toContain('never-handed');
    expect(env.ABE_LOGINS_SECRET).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe('awsRunner: an aws that does not answer', () => {
  test('is killed at its timeout and said so (the box scan waits 5 s, not 30)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slow-aws-'));

    writeFileSync(join(dir, 'aws'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    try {
      const began = Date.now();
      const out = await awsRunner(
        { PATH: `${dir}:/usr/bin:/bin` },
        200,
      )(['ec2', 'describe-instances']);

      expect(out).toEqual({
        ok: false,
        error: {
          code: 'aws-failed',
          message: 'aws ec2 describe-instances gave no answer in 0.2 s',
        },
      });
      expect(Date.now() - began).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
