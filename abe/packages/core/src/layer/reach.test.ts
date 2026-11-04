/** Rule tables for Reach: the names a session gets per environment and target, and `abe reach check`. */
import { describe, expect, test } from 'bun:test';
import {
  awsConfigText,
  awsProfiles,
  checkReach,
  credsPlan,
  type Environments,
  type LayerSource,
  mergeSettings,
  parseReachName,
  type Reach,
  reachEnv,
  reachName,
  reachOf,
  type ReachTarget,
  reachVars,
  sessionName,
} from '../index';

const ENVS: Environments = {
  test: {
    account: '111111111111',
    region: 'eu-west-1',
    db: { read: { secret: 'abe/test/db-read' }, write: { secret: 'abe/test/db-write' } },
  },
  prod: { account: '222222222222', region: 'eu-west-1' },
};

const reach = (writes: string[] = []): Reach => ({ environments: ENVS, writes });

describe('the four name shapes', () => {
  test.each<[string, ReturnType<typeof parseReachName>]>([
    [
      'ABE_AWS_READ_TEST',
      { name: 'ABE_AWS_READ_TEST', service: 'aws', access: 'read', environment: 'test' },
    ],
    [
      'ABE_AWS_WRITE_PROD',
      { name: 'ABE_AWS_WRITE_PROD', service: 'aws', access: 'write', environment: 'prod' },
    ],
    [
      'ABE_DB_READ_URL_TEST',
      { name: 'ABE_DB_READ_URL_TEST', service: 'db', access: 'read', environment: 'test' },
    ],
    [
      'ABE_DB_WRITE_URL_PROD2',
      { name: 'ABE_DB_WRITE_URL_PROD2', service: 'db', access: 'write', environment: 'prod2' },
    ],
    ['ABE_DB_READ_TEST', undefined],
    ['ABE_AWS_READ_URL_TEST', undefined],
    ['ABE_S3_READ_TEST', undefined],
    ['ABE_AWS_READ', undefined],
    ['ABE_AWS_READ_MY_TEST', undefined],
    ['abe_aws_read_test', undefined],
    ['AWS_READ_TEST', undefined],
  ])('%s', (name, parsed) => {
    expect(parseReachName(name)).toEqual(parsed);
  });

  test('reachName writes them back', () => {
    expect(reachName('db', 'write', 'test')).toBe('ABE_DB_WRITE_URL_TEST');
    expect(reachName('aws', 'read', 'prod')).toBe('ABE_AWS_READ_PROD');
  });
});

const names = (r: Reach, target: ReachTarget) => reachVars(r, target).map((v) => v.name);

describe('the names a session gets', () => {
  test.each<[string, Reach, ReachTarget, string[]]>([
    [
      'every read name, local',
      reach(),
      'local',
      ['ABE_AWS_READ_PROD', 'ABE_AWS_READ_TEST', 'ABE_DB_READ_URL_TEST'],
    ],
    [
      'every read name, cloud, nothing granted',
      reach(),
      'cloud',
      ['ABE_AWS_READ_PROD', 'ABE_AWS_READ_TEST', 'ABE_DB_READ_URL_TEST'],
    ],
    [
      'granted writes in the cloud',
      reach(['ABE_AWS_WRITE_PROD', 'ABE_DB_WRITE_URL_TEST']),
      'cloud',
      [
        'ABE_AWS_READ_PROD',
        'ABE_AWS_WRITE_PROD',
        'ABE_AWS_READ_TEST',
        'ABE_DB_READ_URL_TEST',
        'ABE_DB_WRITE_URL_TEST',
      ],
    ],
    [
      'local never gets a write, granted or not',
      reach(['ABE_AWS_WRITE_PROD', 'ABE_AWS_WRITE_TEST', 'ABE_DB_WRITE_URL_TEST']),
      'local',
      ['ABE_AWS_READ_PROD', 'ABE_AWS_READ_TEST', 'ABE_DB_READ_URL_TEST'],
    ],
    [
      'a grant for an environment the repo does not list gives nothing',
      reach(['ABE_AWS_WRITE_STAGE']),
      'cloud',
      ['ABE_AWS_READ_PROD', 'ABE_AWS_READ_TEST', 'ABE_DB_READ_URL_TEST'],
    ],
    [
      'a database write with no secret behind it gives nothing',
      reach(['ABE_DB_WRITE_URL_PROD']),
      'cloud',
      ['ABE_AWS_READ_PROD', 'ABE_AWS_READ_TEST', 'ABE_DB_READ_URL_TEST'],
    ],
    ['no environments, no names', { environments: {}, writes: [] }, 'cloud', []],
  ])('%s', (_, r, target, expected) => {
    expect(names(r, target)).toEqual(expected);
  });

  test('values: AWS names are profiles, database names their secret', () => {
    const vars = reachVars(reach(['ABE_DB_WRITE_URL_TEST']), 'cloud');
    const env = reachEnv(vars, {
      'abe/test/db-read': 'postgres://r',
      'abe/test/db-write': 'pg://w',
    });

    expect(env).toEqual({
      ok: true,
      env: {
        ABE_AWS_READ_PROD: 'abe-read-prod',
        ABE_AWS_READ_TEST: 'abe-read-test',
        ABE_DB_READ_URL_TEST: 'postgres://r',
        ABE_DB_WRITE_URL_TEST: 'pg://w',
      },
    });
  });

  test('a secret not read is named, never left empty', () => {
    expect(reachEnv(reachVars(reach(), 'local'), {})).toEqual({
      ok: false,
      missing: ['abe/test/db-read'],
    });
  });
});

describe('profiles', () => {
  test('one profile per AWS name, each calling abe reach creds', () => {
    const profiles = awsProfiles(reachVars(reach(['ABE_AWS_WRITE_TEST']), 'cloud'));

    expect(awsConfigText(profiles)).toBe(
      [
        '[profile abe-read-prod]',
        'credential_process = abe reach creds prod read',
        'region = eu-west-1',
        '',
        '[profile abe-read-test]',
        'credential_process = abe reach creds test read',
        'region = eu-west-1',
        '',
        '[profile abe-write-test]',
        'credential_process = abe reach creds test write',
        'region = eu-west-1',
        '',
      ].join('\n'),
    );
  });
});

describe('creds', () => {
  test.each<[string, Reach, string, 'read' | 'write', ReturnType<typeof credsPlan>]>([
    [
      'a granted write off a box: never locally',
      reach(['ABE_AWS_WRITE_PROD']),
      'prod',
      'write',
      {
        ok: false,
        code: 'no-reach',
        message: 'ABE_AWS_WRITE_PROD is never given locally: only in your cloud environment',
      },
    ],
    [
      'read assumes abe-read for an hour',
      reach(),
      'test',
      'read',
      {
        ok: true,
        plan: {
          environment: 'test',
          access: 'read',
          roleArn: 'arn:aws:iam::111111111111:role/abe-read',
          region: 'eu-west-1',
          durationSeconds: 3600,
        },
      },
    ],
    [
      'a granted write assumes abe-write',
      reach(['ABE_AWS_WRITE_PROD']),
      'prod',
      'write',
      {
        ok: true,
        plan: {
          environment: 'prod',
          access: 'write',
          roleArn: 'arn:aws:iam::222222222222:role/abe-write',
          region: 'eu-west-1',
          durationSeconds: 3600,
        },
      },
    ],
    [
      'a write without a grant',
      reach(['ABE_AWS_WRITE_TEST', 'ABE_DB_WRITE_URL_PROD']),
      'prod',
      'write',
      { ok: false, code: 'no-reach', message: 'ABE_AWS_WRITE_PROD is not granted in this repo' },
    ],
    [
      'an environment the repo does not list',
      reach(),
      'stage',
      'read',
      {
        ok: false,
        code: 'unknown-environment',
        message: 'stage is not an environment the repo lists (prod, test)',
      },
    ],
  ])('%s', (name, r, env, access, plan) => {
    expect(credsPlan(r, env, access, name.includes('off a box') ? 'local' : 'cloud')).toEqual(plan);
  });

  test('a read is given locally too', () => {
    expect(credsPlan(reach(), 'test', 'read', 'local').ok).toBe(true);
  });

  test('the session is named for the person', () => {
    expect(sessionName('octocat')).toBe('abe-octocat');
  });
});

const REPO_DOC = {
  environments: {
    test: { account: '111111111111', db: { read: { secret: 'abe/test/db-read' } } },
    prod: { account: '222222222222' },
  },
  reach: ['ABE_AWS_READ_TEST'],
};
const REPO = '/r/abe.yaml';
const file = (doc: unknown): LayerSource => ({ place: 'repo', file: REPO, doc });
const repo = (more: Record<string, unknown> = {}) => file({ ...REPO_DOC, ...more });
const grant = (value: unknown, reason: unknown = 'migrations') => ({
  overrides: { reach: { value, reason } },
});

describe('abe reach check', () => {
  test.each<[string, LayerSource[]]>([
    ['the repo alone', [repo()]],
    ['granting a write by Override with a reason', [repo(grant(['ABE_AWS_WRITE_TEST']))]],
    ['listing reads', [repo({ reach: ['ABE_AWS_READ_PROD', 'ABE_DB_READ_URL_TEST'] })]],
    ['a file with no Reach', [file({ checks: ['e2e'] })]],
    [
      'an environment naming the write policy abe-write gets',
      [
        repo({
          environments: {
            test: { account: '111111111111', writePolicy: 'policies/test-write.json' },
          },
        }),
      ],
    ],
  ])('clean: %s', (_, sources) => {
    expect(checkReach(sources)).toEqual([]);
  });

  test.each<[string, LayerSource[], { code: string; file: string; path: string }[]]>([
    [
      'a name outside the four shapes',
      [repo({ reach: ['ABE_AWS_READ_TEST', 'ABE_S3_READ_TEST', 'ABE_DB_READ_TEST'] })],
      [
        { code: 'unknown-name', file: REPO, path: 'reach[1]' },
        { code: 'unknown-name', file: REPO, path: 'reach[2]' },
      ],
    ],
    [
      'a name that is no ABE_* name at all',
      [repo(grant(['AWS_PROFILE']))],
      [{ code: 'unknown-name', file: REPO, path: 'overrides.reach.value[0]' }],
    ],
    [
      'an environment the repo does not list',
      [repo({ reach: ['ABE_AWS_READ_STAGE'] })],
      [{ code: 'unknown-environment', file: REPO, path: 'reach[0]' }],
    ],
    [
      'a write without an Override',
      [repo({ reach: ['ABE_AWS_WRITE_TEST'] })],
      [{ code: 'override-required', file: REPO, path: 'reach[0]' }],
    ],
    [
      'an Override without a reason',
      [repo(grant(['ABE_AWS_WRITE_TEST'], '  '))],
      [{ code: 'reason-required', file: REPO, path: 'overrides.reach.reason' }],
    ],
    [
      'an Override with no reason at all',
      [repo({ overrides: { reach: { value: ['ABE_AWS_WRITE_TEST'] } } })],
      [{ code: 'reason-required', file: REPO, path: 'overrides.reach.reason' }],
    ],
    [
      'a database name the repo has no secret for',
      [repo(grant(['ABE_DB_WRITE_URL_TEST', 'ABE_DB_READ_URL_PROD']))],
      [
        { code: 'no-source', file: REPO, path: 'overrides.reach.value[0]' },
        { code: 'no-source', file: REPO, path: 'overrides.reach.value[1]' },
      ],
    ],
    [
      'reach that is not a list',
      [repo({ reach: 'ABE_AWS_READ_TEST' })],
      [{ code: 'invalid-setting', file: REPO, path: 'reach' }],
    ],
    [
      'an environment with a bad account',
      [file({ environments: { test: { account: '42' } } })],
      [{ code: 'invalid-setting', file: REPO, path: 'environments' }],
    ],
    ...['/etc/write.json', '../write.json', 'policies/../../write.json', 'policies/write.yaml'].map(
      (writePolicy): [string, LayerSource[], { code: string; file: string; path: string }[]] => [
        `a write policy that is no JSON file in the repo: ${writePolicy}`,
        [file({ environments: { test: { account: '111111111111', writePolicy } } })],
        [{ code: 'invalid-setting', file: REPO, path: 'environments' }],
      ],
    ),
    [
      "every problem of the file, the Layer's own first",
      [
        repo({
          reach: ['ABE_AWS_WRITE_TEST', 'ABE_AWS_READ_QA'],
          ...grant(['ABE_AWS_WRITE_PROD'], ''),
        }),
      ],
      [
        { code: 'reason-required', file: REPO, path: 'overrides.reach.reason' },
        { code: 'override-required', file: REPO, path: 'reach[0]' },
        { code: 'unknown-environment', file: REPO, path: 'reach[1]' },
      ],
    ],
  ])('refused: %s', (_, sources, problems) => {
    const found = checkReach(sources);

    expect(found.map(({ code, file, path }) => ({ code, file, path }))).toEqual(problems);
    for (const p of found) expect(p.reason).not.toBe('');
  });
});

describe('what the settings in force grant', () => {
  const mine = (doc: unknown): LayerSource => ({
    place: 'local',
    file: '/r/.abe/settings.local.yaml',
    doc,
  });

  test.each<[string, LayerSource[], string[]]>([
    ['nothing granted', [repo()], []],
    ["the repo's Override grants", [repo(grant(['ABE_AWS_WRITE_TEST']))], ['ABE_AWS_WRITE_TEST']],
    [
      "the repo's Override never grants a write to prod (ADR 0029)",
      [repo(grant(['ABE_AWS_WRITE_PROD'], 'ops'))],
      [],
    ],
    ['a plain write grants nothing', [repo({ reach: ['ABE_AWS_WRITE_TEST'] })], []],
    ['an Override without a reason grants nothing', [repo(grant(['ABE_AWS_WRITE_TEST'], ''))], []],
    ['your Override never grants a write', [repo(), mine(grant(['ABE_AWS_WRITE_TEST']))], []],
  ])('%s', (_, sources, writes) => {
    const r = reachOf(mergeSettings(sources));

    expect(r.writes).toEqual(writes);
    expect(Object.keys(r.environments).sort()).toEqual(['prod', 'test']);
  });
});
