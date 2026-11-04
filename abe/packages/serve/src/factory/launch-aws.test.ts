import { expect, test } from 'bun:test';
import { awsLoginsRefused } from './launch-aws';

test('aws logins at launch: one read per profile, all at once; a slow one not refused', async () => {
  const asked: string[] = [];
  const said = await awsLoginsRefused({
    check: (profile) => {
      asked.push(profile);
      if (profile === 'shop-slow') return new Promise(() => undefined);

      return Promise.resolve(
        profile === 'shop-test' ? { ok: false, why: 'Token has expired' } : { ok: true },
      );
    },
    credentials: {
      dev: { awsProfile: 'shop-test' },
      test: { awsProfile: 'shop-test' },
      prod: { awsProfile: 'shop-slow' },
    },
    envs: ['dev', 'test', 'prod'],
    timeoutMs: 20,
  });

  expect(asked).toEqual(['shop-test', 'shop-slow']);
  expect(said).toEqual({
    ok: false,
    error: {
      code: 'aws-login-expired',
      message:
        "the aws login of dev and test (shop-test) is expired or missing, and a run can't sign in: sign in yourself in Terminal, then launch again: abe login aws --profile shop-test",
    },
  });
});
