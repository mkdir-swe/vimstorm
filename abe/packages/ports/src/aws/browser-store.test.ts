/**
 * Browser profiles' secrets through a fake `aws`: whose they are (the logins secret tagged with
 * your owner, or the box's `$ABE_LOGINS_SECRET`), a first write made and fenced as the logins are
 * before any value goes in, a value only ever on a put's stdin; and the folder standing in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeAws, type FakeAws, type ToolAnswer, type ToolCall } from '@abe/testing';
import { awsProfileStore, fileProfileStore, profileStoreFrom } from './browser-store';

const LOGINS = 'arn:aws:secretsmanager:eu-north-1:111111111111:secret:abe/octo/logins-AbCdEf';
const SECRET = 'abe/octo/browser/work';
const VALUE = '{"v":1,"cookies":[{"name":"sid","value":"cookie-value-secret"}],"origins":[]}';
const FENCE =
  '{"Version":"2012-10-17","Statement":[{"Sid":"Fence","Effect":"Deny","Principal":"*","Action":"secretsmanager:GetSecretValue","Resource":"*"}]}';

const NOT_FOUND: ToolAnswer = {
  stderr:
    "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret.",
  exit: 254,
};

const LIST_MINE: readonly [string, ToolAnswer] = [
  'Key=tag-value,Values=octocat',
  {
    json: {
      SecretList: [
        {
          ARN: 'arn:aws:secretsmanager:eu-north-1:111111111111:secret:abe/octo2/logins-ZzZzZz',
          Name: 'abe/octo2/logins',
          // Tagged with the value under another key: not yours.
          Tags: [{ Key: 'abe:team', Value: 'octocat' }],
        },
        {
          ARN: LOGINS,
          Name: 'abe/octo/logins',
          Tags: [
            { Key: 'abe:owner', Value: 'octocat' },
            { Key: 'abe:team', Value: 'platform' },
          ],
        },
      ],
    },
  },
];

const LOGINS_DESCRIBED: readonly [string, ToolAnswer] = [
  `describe-secret --secret-id ${LOGINS}`,
  {
    json: {
      ARN: LOGINS,
      Name: 'abe/octo/logins',
      Tags: [
        { Key: 'project', Value: 'abe' },
        { Key: 'abe:owner', Value: 'octocat' },
        { Key: 'abe:team', Value: 'platform' },
      ],
    },
  },
];

let aws: FakeAws | undefined;
const dirs: string[] = [];

afterEach(() => {
  aws?.remove();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const owner = () => Promise.resolve({ ok: true, data: 'octocat' } as const);

const storeOn = (fake: FakeAws, env: Record<string, string> = {}) =>
  awsProfileStore({ env: { PATH: fake.path, HOME: fake.dir, ...env }, owner });

/** The secretsmanager operation of each call. */
const ops = (calls: readonly ToolCall[]) => calls.map((c) => c.argv[1]);

const flag = (call: ToolCall | undefined, name: string) => {
  const i = call?.argv.indexOf(name) ?? -1;

  return i === -1 ? undefined : call?.argv[i + 1];
};

describe('the Secrets Manager store', () => {
  test('a first write makes the secret unvalued and fenced, then puts the value on stdin', async () => {
    aws = fakeAws([
      LIST_MINE,
      [`describe-secret --secret-id ${SECRET}`, NOT_FOUND],
      [
        'get-resource-policy',
        { json: { ARN: LOGINS, Name: 'abe/octo/logins', ResourcePolicy: FENCE } },
      ],
      LOGINS_DESCRIBED,
      ['create-secret', { json: { ARN: `${SECRET}-Qq`, Name: SECRET } }],
      ['put-resource-policy', { json: { ARN: `${SECRET}-Qq`, Name: SECRET } }],
      ['put-secret-value', { stdout: 'v-1\n' }],
    ]);

    expect(await storeOn(aws).write('work', VALUE)).toEqual({ ok: true, data: { secret: SECRET } });
    const calls = aws.calls();

    expect(ops(calls)).toEqual([
      'list-secrets',
      'describe-secret',
      'get-resource-policy',
      'describe-secret',
      'create-secret',
      'put-resource-policy',
      'put-secret-value',
    ]);
    const [listed, , policy, , created, fenced, put] = calls;

    expect(listed?.argv).toContain('Key=tag-key,Values=abe:owner');
    expect(flag(policy, '--secret-id')).toBe(LOGINS);
    expect(flag(created, '--name')).toBe(SECRET);
    expect(flag(created, '--kms-key-id')).toBe('alias/abe-logins');
    expect(created?.argv).not.toContain('--secret-string');
    for (const t of [
      'Key=abe:owner,Value=octocat',
      'Key=abe:team,Value=platform',
      'Key=project,Value=abe',
    ])
      expect(created?.argv).toContain(t);
    expect(flag(fenced, '--secret-id')).toBe(SECRET);
    expect(flag(fenced, '--resource-policy')).toBe(FENCE);
    expect(fenced?.argv).toContain('--block-public-policy');
    expect(flag(put, '--secret-string')).toBe('file:///dev/stdin');
    expect(put?.stdin).toBe(VALUE);
    // The value is on that one stdin only: in no call's argv, no other call's stdin.
    for (const c of calls) {
      expect(c.argv.join(' ')).not.toContain('cookie-value-secret');
      if (c !== put) expect(c.stdin).toBe('');
      // In the logins' region (from their ARN), once it is known.
      if (c !== listed) expect(c.argv.slice(-2)).toEqual(['--region', 'eu-north-1']);
    }
    // aws runs on awsEnv: no pager.
    expect(put?.env.AWS_PAGER).toBe('');
  });

  test('a write to a secret that is there only puts the value', async () => {
    aws = fakeAws([
      LIST_MINE,
      [`describe-secret --secret-id ${SECRET}`, { json: { ARN: `${SECRET}-Qq`, Name: SECRET } }],
      [`get-resource-policy --secret-id ${SECRET}`, { json: { ResourcePolicy: FENCE } }],
      ['put-secret-value', { stdout: 'v-2\n' }],
    ]);

    expect(await storeOn(aws).write('work', VALUE)).toEqual({ ok: true, data: { secret: SECRET } });
    expect(ops(aws.calls())).toEqual([
      'list-secrets',
      'describe-secret',
      'get-resource-policy',
      'put-secret-value',
    ]);
  });

  test('a secret that is there unfenced gets no value', async () => {
    aws = fakeAws([
      LIST_MINE,
      [`describe-secret --secret-id ${SECRET}`, { json: { ARN: `${SECRET}-Qq`, Name: SECRET } }],
      [`get-resource-policy --secret-id ${SECRET}`, { json: { ARN: `${SECRET}-Qq` } }],
    ]);
    const r = await storeOn(aws).write('work', VALUE);

    expect(r.ok ? '' : r.error.code).toBe('no-fence');
    expect(ops(aws.calls())).not.toContain('put-secret-value');
  });

  test('a secret removed within its recovery window is restored, then written', async () => {
    aws = fakeAws([
      LIST_MINE,
      [
        `describe-secret --secret-id ${SECRET}`,
        { json: { ARN: `${SECRET}-Qq`, Name: SECRET, DeletedDate: '2026-10-23T10:00:00+00:00' } },
      ],
      ['restore-secret', { json: { ARN: `${SECRET}-Qq` } }],
      [`get-resource-policy --secret-id ${SECRET}`, { json: { ResourcePolicy: FENCE } }],
      ['put-secret-value', { stdout: 'v-3\n' }],
    ]);

    expect((await storeOn(aws).write('work', VALUE)).ok).toBe(true);
    expect(ops(aws.calls())).toEqual([
      'list-secrets',
      'describe-secret',
      'restore-secret',
      'get-resource-policy',
      'put-secret-value',
    ]);
  });

  test('no fence on the logins: refused, nothing made', async () => {
    aws = fakeAws([
      LIST_MINE,
      [`describe-secret --secret-id ${SECRET}`, NOT_FOUND],
      ['get-resource-policy', { json: { ARN: LOGINS, Name: 'abe/octo/logins' } }],
    ]);
    const wrote = await storeOn(aws).write('work', VALUE);

    if (wrote.ok) throw new Error('expected a refusal');
    expect(wrote.error.code).toBe('no-fence');
    expect(wrote.error.message).toContain('nothing was made');
    expect(ops(aws.calls())).not.toContain('create-secret');
    expect(ops(aws.calls())).not.toContain('put-secret-value');
  });

  test('a fence that will not go on removes the secret it made', async () => {
    aws = fakeAws([
      LIST_MINE,
      [`describe-secret --secret-id ${SECRET}`, NOT_FOUND],
      ['get-resource-policy', { json: { ARN: LOGINS, ResourcePolicy: FENCE } }],
      LOGINS_DESCRIBED,
      ['create-secret', { json: { ARN: `${SECRET}-Qq` } }],
      ['delete-secret', { json: { ARN: `${SECRET}-Qq` } }],
    ]);
    const wrote = await storeOn(aws).write('work', VALUE);

    expect(!wrote.ok && wrote.error.code).toBe('no-fence');
    const calls = aws.calls();

    expect(ops(calls).slice(-2)).toEqual(['put-resource-policy', 'delete-secret']);
    expect(calls.at(-1)?.argv).toContain('--force-delete-without-recovery');
    expect(ops(calls)).not.toContain('put-secret-value');
  });

  test('a read gives the text and when it was stored; none stored reads as null', async () => {
    aws = fakeAws([
      LIST_MINE,
      [
        `--secret-id ${SECRET} `,
        { json: { text: VALUE, createdAt: '2026-10-23T02:30:00.123000+00:00' } },
      ],
      ['get-secret-value', NOT_FOUND],
    ]);
    const store = storeOn(aws);

    expect(await store.read('work')).toEqual({
      ok: true,
      data: { secret: SECRET, text: VALUE, storedAt: '2026-10-23T02:30:00.123Z' },
    });
    expect(await store.read('work-admin')).toEqual({ ok: true, data: null });
    // The person is looked up once per store.
    expect(ops(aws.calls())).toEqual(['list-secrets', 'get-secret-value', 'get-secret-value']);
  });

  test('a secret that cannot be read is profile-unreadable, naming the secret only', async () => {
    aws = fakeAws([LIST_MINE]);
    const read = await storeOn(aws).read('work');

    if (read.ok) throw new Error('expected a refusal');
    expect(read.error.code).toBe('profile-unreadable');
    expect(read.error.message).toStartWith(`${SECRET}: An error occurred (AccessDenied)`);
  });

  test('the list: your profiles under the prefix with when each was last written', async () => {
    aws = fakeAws([
      LIST_MINE,
      [
        'Key=name,Values=abe/octo/browser/',
        {
          json: {
            SecretList: [
              {
                ARN: 'arn:x:2',
                Name: 'abe/octo/browser/work-admin',
                LastChangedDate: '2026-10-22T09:00:00+00:00',
              },
              {
                ARN: 'arn:x:1',
                Name: 'abe/octo/browser/work',
                LastChangedDate: '2026-10-23T02:30:00.5+00:00',
              },
              // A prefix match of Secrets Manager's that is no profile of this store.
              { ARN: 'arn:x:3', Name: 'abe/octo/browser/x/y', LastChangedDate: '2026-10-01' },
            ],
          },
        },
      ],
    ]);

    expect(await storeOn(aws).list()).toEqual({
      ok: true,
      data: [
        { name: 'work', secret: 'abe/octo/browser/work', storedAt: '2026-10-23T02:30:00.500Z' },
        {
          name: 'work-admin',
          secret: 'abe/octo/browser/work-admin',
          storedAt: '2026-10-22T09:00:00.000Z',
        },
      ],
    });
  });

  test('on a box the logins secret it was given names the person: no list needed', async () => {
    aws = fakeAws([['delete-secret', NOT_FOUND]]);

    expect(await storeOn(aws, { ABE_LOGINS_SECRET: LOGINS }).remove('work')).toEqual({
      ok: true,
      data: null,
    });
    const [call] = aws.calls();

    expect(ops(aws.calls())).toEqual(['delete-secret']);
    expect(flag(call, '--secret-id')).toBe(SECRET);
    expect(flag(call, '--recovery-window-in-days')).toBe('7');
    expect(call?.argv.slice(-2)).toEqual(['--region', 'eu-north-1']);
  });

  test('no logins secret tagged with your owner: no-person, saying where you must be', async () => {
    aws = fakeAws([['Key=tag-value,Values=octocat', { json: { SecretList: [] } }]]);
    const listed = await storeOn(aws).list();

    if (listed.ok) throw new Error('expected a refusal');
    expect(listed.error.code).toBe('no-person');
    expect(listed.error.message).toContain('octocat');
    expect(listed.error.message).toContain('infra/aws');
  });
});

describe('the folder standing in', () => {
  test('write, list, read and remove, each file private', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-profiles-'));

    dirs.push(dir);
    const store = profileStoreFrom({
      ABE_LOGINS_STORE: pathToFileURL(dir).href,
      ABE_OWNER: 'octo',
    });

    expect(await store.read('work')).toEqual({ ok: true, data: null });
    expect(await store.write('work', VALUE)).toEqual({ ok: true, data: { secret: SECRET } });
    expect(statSync(join(dir, SECRET)).mode & 0o777).toBe(0o600);
    const read = await store.read('work');

    expect(read.ok && read.data?.text).toBe(VALUE);
    const listed = await store.list();

    expect(listed.ok && listed.data.map((p) => [p.name, p.secret])).toEqual([['work', SECRET]]);
    expect(await store.remove('work')).toEqual({ ok: true, data: null });
    expect(await store.remove('work')).toEqual({ ok: true, data: null });
    expect(await fileProfileStore(dir, 'octo').list()).toEqual({ ok: true, data: [] });
  });

  test("the person is the logins secret's when one is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-profiles-'));

    dirs.push(dir);
    const store = profileStoreFrom({
      ABE_LOGINS_STORE: pathToFileURL(dir).href,
      ABE_LOGINS_SECRET: LOGINS,
      ABE_OWNER: 'octocat',
    });

    expect(await store.write('work', VALUE)).toEqual({ ok: true, data: { secret: SECRET } });
  });
});
