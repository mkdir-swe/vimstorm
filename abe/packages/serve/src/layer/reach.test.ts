/**
 * `abe reach` through the CLI seam: the real `abe` and its `serve`, typed in a fixture checkout whose
 * `abe.yaml` holds the repo's environments and grants (ADR 0030), a fake `aws` keeping
 * each AssumeRole and serving the secrets, and a fake `gh` saying who you are.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReachCheckData,
  ReachCredsData,
  ReachEnvData,
  ReachProfilesData,
  StatusData,
} from '@abe/core';
import {
  assumedRoles,
  cli,
  type Cli,
  type FakeAws,
  fakeAws,
  type FakeGh,
  fakeGh,
  ghUser,
  secretText,
  type Streaming,
  stsAssumed,
  until,
} from '@abe/testing';

const ENVIRONMENTS = [
  'environments:',
  '  test:',
  '    account: "111111111111"',
  '    region: eu-west-1',
  '    db:',
  '      read: { secret: abe/test/db-read }',
  '      write: { secret: abe/test/db-write }',
  '  prod:',
  '    account: "222222222222"',
  '    region: eu-west-1',
  '',
].join('\n');

/** The repo's file: its environments, and the writes it grants by an Override. */
const REPO = [
  ENVIRONMENTS,
  'overrides:',
  '  reach:',
  '    value: [ABE_AWS_WRITE_TEST, ABE_DB_WRITE_URL_TEST]',
  '    reason: the repo runs its own migrations on test',
  '',
].join('\n');

/** A checkout `repo` and your config folder `mine` in a temporary folder. */
type Fixture = {
  root: string;
  repo: string;
  mine: string;
  write: (path: string, text: string) => void;
};

const tree = (files: Record<string, string>): Fixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-reach-')));
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  mkdirSync(join(root, 'mine'));
  for (const [path, text] of Object.entries(files)) write(path, text);

  return { root, repo: join(root, 'repo'), mine: join(root, 'mine'), write };
};

const shopRepo = () => tree({ 'repo/abe.yaml': REPO });

const SECRETS = {
  read: 'postgres://reader:r3ad@test-db:5432/shop',
  write: 'postgres://w:wr1te@test-db/shop',
};

/** `abe`, typed in the checkout `f.repo` unless a run says otherwise. */
type World = { f: Fixture; aws: FakeAws; gh: FakeGh; abe: Cli; serve?: Streaming };

const world = (
  f: Fixture,
  o: { login?: boolean; local?: boolean; env?: Record<string, string> } = {},
): World => {
  const aws = fakeAws([
    ['sts assume-role', { json: stsAssumed() }],
    ['--secret-id abe/test/db-read ', secretText(SECRETS.read)],
    ['--secret-id abe/test/db-write ', secretText(SECRETS.write)],
  ]);
  const gh = fakeGh(o.login === false ? [] : [['api user', { json: ghUser('octocat') }]]);
  const abe = cli({
    cwd: f.repo,
    env: {
      ABE_CONFIG_DIR: f.mine,
      PATH: `${aws.dir}:${gh.path}`,
      // A box's serve unless asked otherwise: writes are given only there.
      ...(o.local === true ? {} : { ABE_REACH_TARGET: 'cloud' }),
      ...o.env,
    },
  });

  return { f, aws, gh, abe };
};

/**
 * A box's `serve` (`ABE_BOX=1`, as its unit starts it, with `owner` as `ABE_OWNER` when given): a
 * client there never starts one, so it is started here and waited for.
 */
const boxWorld = async (f: Fixture, owner?: string): Promise<World> => {
  const w = world(f, {
    env: { ABE_BOX: '1', ...(owner === undefined ? {} : { ABE_OWNER: owner }) },
  });
  const serve = w.abe.spawn('serve');

  await until('the box serve', async () => {
    const status = await w.abe.json(StatusData, 'status');

    return status.doc.ok ? true : undefined;
  });

  return { ...w, serve };
};

const done = async (w: World) => {
  await w.abe.close();
  w.serve?.signal('SIGKILL');
  w.aws.remove();
  w.gh.remove();
  rmSync(w.f.root, { recursive: true, force: true });
};

const secretReads = (w: World) =>
  w.aws
    .calls()
    .filter((c) => c.argv[0] === 'secretsmanager')
    .map((c) => c.argv[3]);

describe('abe reach env / profiles', () => {
  let w: World;

  beforeAll(() => {
    w = world(shopRepo());
  });
  afterAll(() => done(w));

  test('cloud: every read name, and the writes the repo grants', async () => {
    expect(await w.abe.json(ReachEnvData, 'reach', 'env', '--target', 'cloud')).toEqual({
      exit: 0,
      stderr: '',
      doc: {
        ok: true,
        data: {
          target: 'cloud',
          env: {
            ABE_AWS_READ_PROD: 'abe-read-prod',
            ABE_AWS_READ_TEST: 'abe-read-test',
            ABE_AWS_WRITE_TEST: 'abe-write-test',
            ABE_DB_READ_URL_TEST: SECRETS.read,
            ABE_DB_WRITE_URL_TEST: SECRETS.write,
          },
        },
      },
    });
    expect(secretReads(w).sort()).toEqual(['abe/test/db-read', 'abe/test/db-write']);
    const read = w.aws.calls().find((c) => c.argv.includes('abe/test/db-read'));

    expect(read?.argv).toEqual([
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      'abe/test/db-read',
      '--query',
      'SecretString',
      '--region',
      'eu-west-1',
      '--output',
      'text',
    ]);
  });

  test('local: reads only; the write secret is never read', async () => {
    const before = secretReads(w).length;
    const out = await w.abe.json(ReachEnvData, 'reach', 'env', '--target', 'local');

    expect(out.doc).toEqual({
      ok: true,
      data: {
        target: 'local',
        env: {
          ABE_AWS_READ_PROD: 'abe-read-prod',
          ABE_AWS_READ_TEST: 'abe-read-test',
          ABE_DB_READ_URL_TEST: SECRETS.read,
        },
      },
    });
    expect(secretReads(w).slice(before)).toEqual(['abe/test/db-read']);
  });

  test('the text form is one NAME=value line each', async () => {
    const out = await w.abe.run('reach', 'env', '--target', 'local');

    expect(out).toEqual({
      exit: 0,
      stderr: '',
      stdout: [
        'ABE_AWS_READ_PROD=abe-read-prod',
        'ABE_AWS_READ_TEST=abe-read-test',
        `ABE_DB_READ_URL_TEST=${SECRETS.read}`,
        '',
      ].join('\n'),
    });
  });

  test('profiles: AWS config text, one profile per AWS name', async () => {
    const out = await w.abe.run('reach', 'profiles', '--target', 'cloud');

    expect(out.exit).toBe(0);
    expect(out.stdout).toBe(
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

  test('profiles --target local has no write profile', async () => {
    const out = await w.abe.json(ReachProfilesData, 'reach', 'profiles', '--target', 'local');

    if (!out.doc.ok) throw new Error(out.doc.error.message);
    expect(out.doc.data.profiles.map((p) => p.profile)).toEqual(['abe-read-prod', 'abe-read-test']);
    expect(out.doc.data.config).not.toContain('write');
  });

  test('a target is required and only cloud or local', async () => {
    expect((await w.abe.run('reach', 'env')).exit).toBe(2);
    expect((await w.abe.run('reach', 'env', '--target', 'box')).exit).toBe(2);
  });
});

describe('abe reach creds', () => {
  let w: World;

  beforeAll(() => {
    w = world(shopRepo());
  });
  afterAll(() => done(w));

  test('read: credential_process JSON from one AssumeRole of abe-read, as you', async () => {
    const out = await w.abe.run('reach', 'creds', 'test', 'read');

    expect(out.exit).toBe(0);
    expect(ReachCredsData.parse(JSON.parse(out.stdout))).toEqual({
      Version: 1,
      AccessKeyId: 'ASIAFAKEFAKEFAKE0001',
      SecretAccessKey: 'fake-secret-access-key',
      SessionToken: 'fake-session-token',
      Expiration: '2099-01-01T00:00:00+00:00',
    });
    expect(out.stdout.split('\n')).toHaveLength(2);
    expect(assumedRoles(w.aws.calls())).toEqual([
      {
        role: 'arn:aws:iam::111111111111:role/abe-read',
        sourceIdentity: 'octocat',
        duration: 3600,
        sessionName: 'abe-octocat',
        region: 'eu-west-1',
      },
    ]);
  });

  test('asked again while they last: no second AssumeRole', async () => {
    const out = await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'read');

    expect(out.doc.ok).toBe(true);
    expect(assumedRoles(w.aws.calls())).toHaveLength(1);
  });

  test('a granted write assumes abe-write', async () => {
    expect((await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'write')).exit).toBe(0);
    expect(assumedRoles(w.aws.calls()).at(-1)).toMatchObject({
      role: 'arn:aws:iam::111111111111:role/abe-write',
      sourceIdentity: 'octocat',
      duration: 3600,
    });
  });

  test('write without a grant: no-reach, and no AWS call', async () => {
    const before = w.aws.calls().length;

    expect(await w.abe.json(ReachCredsData, 'reach', 'creds', 'prod', 'write')).toMatchObject({
      exit: 1,
      doc: {
        ok: false,
        error: { code: 'no-reach', message: 'ABE_AWS_WRITE_PROD is not granted in this repo' },
      },
    });
    expect(w.aws.calls()).toHaveLength(before);
  });

  test('an environment the repo does not list', async () => {
    expect(await w.abe.json(ReachCredsData, 'reach', 'creds', 'stage', 'read')).toMatchObject({
      exit: 1,
      doc: { ok: false, error: { code: 'unknown-environment' } },
    });
  });

  test('access is read or write', async () => {
    expect((await w.abe.run('reach', 'creds', 'test', 'admin')).exit).toBe(2);
  });

  test('AWS refusing the role is a refusal with its message', async () => {
    w.aws.answer([]);
    const out = await w.abe.json(ReachCredsData, 'reach', 'creds', 'prod', 'read');

    expect(out).toMatchObject({ exit: 1, doc: { ok: false, error: { code: 'aws-failed' } } });
    if (!out.doc.ok) expect(out.doc.error.message).toContain('AccessDenied');
  });
});

describe('a serve on the Mac never gives a write', () => {
  let w: World;

  beforeAll(() => {
    w = world(shopRepo(), { local: true });
  });
  afterAll(() => done(w));

  test('creds write, granted: no-reach, and no AWS call', async () => {
    expect(await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'write')).toMatchObject({
      exit: 1,
      doc: { ok: false, error: { code: 'no-reach' } },
    });
    expect(w.aws.calls()).toEqual([]);
  });

  test('env --target cloud: not-cloud; local still works', async () => {
    expect(await w.abe.json(ReachEnvData, 'reach', 'env', '--target', 'cloud')).toMatchObject({
      exit: 1,
      doc: { ok: false, error: { code: 'not-cloud' } },
    });
    expect((await w.abe.json(ReachEnvData, 'reach', 'env', '--target', 'local')).exit).toBe(0);
  });

  test('creds read works locally', async () => {
    expect((await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'read')).exit).toBe(0);
    expect(assumedRoles(w.aws.calls())).toHaveLength(1);
  });
});

describe('without your GitHub login or a secret', () => {
  let w: World;

  beforeAll(() => {
    w = world(shopRepo(), { login: false });
  });
  afterAll(() => done(w));

  test('creds: no-login, and no AssumeRole', async () => {
    expect(await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'read')).toMatchObject({
      exit: 1,
      doc: { ok: false, error: { code: 'no-login' } },
    });
    expect(assumedRoles(w.aws.calls())).toEqual([]);
  });

  test('env: a secret aws cannot read refuses the whole answer', async () => {
    w.aws.answer([]);
    const out = await w.abe.json(ReachEnvData, 'reach', 'env', '--target', 'local');

    expect(out).toMatchObject({
      exit: 1,
      doc: { ok: false, error: { code: 'secret-unreadable' } },
    });
    if (!out.doc.ok) expect(out.doc.error.message).toContain('abe/test/db-read');
  });
});

describe('on a box: SourceIdentity is its owner (ABE_OWNER), never gh', () => {
  test('creds: one AssumeRole as the owner', async () => {
    const w = await boxWorld(shopRepo(), 'ada');

    try {
      const out = await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'read');

      expect(out.doc.ok).toBe(true);
      expect(assumedRoles(w.aws.calls())).toEqual([
        {
          role: 'arn:aws:iam::111111111111:role/abe-read',
          sourceIdentity: 'ada',
          duration: 3600,
          sessionName: 'abe-ada',
          region: 'eu-west-1',
        },
      ]);
    } finally {
      await done(w);
    }
  });

  test('a box not told its owner: no-login naming ABE_OWNER, and no AssumeRole', async () => {
    const w = await boxWorld(shopRepo());

    try {
      expect(await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'read')).toMatchObject({
        exit: 1,
        doc: {
          ok: false,
          error: {
            code: 'no-login',
            message:
              'your GitHub login, for SourceIdentity: this box was not told whose it is (ABE_OWNER, from its abe:owner tag)',
          },
        },
      });
      expect(assumedRoles(w.aws.calls())).toEqual([]);
    } finally {
      await done(w);
    }
  });
});

describe('a Reach set up wrong is refused where it is used', () => {
  let w: World;

  beforeAll(() => {
    const f = shopRepo();

    f.write('repo/abe.yaml', `${ENVIRONMENTS}reach: [ABE_AWS_WRITE_PROD]\n`);
    w = world(f);
  });
  afterAll(() => done(w));

  test('env, profiles and creds all say bad-reach and name the file', async () => {
    const file = join(w.f.repo, 'abe.yaml');

    for (const argv of [
      ['reach', 'env', '--target', 'cloud'],
      ['reach', 'profiles', '--target', 'local'],
      ['reach', 'creds', 'test', 'read'],
    ]) {
      const out = await w.abe.json(ReachEnvData, ...argv);

      expect(out).toMatchObject({ exit: 1, doc: { ok: false, error: { code: 'bad-reach' } } });
      if (!out.doc.ok) expect(out.doc.error.message).toStartWith(`${file}: reach[0]: `);
    }
    expect(w.aws.calls()).toEqual([]);
  });
});

describe('yours for the repo never grants a write (ADR 0030)', () => {
  let w: World;

  beforeAll(() => {
    w = world(
      tree({
        'repo/abe.yaml': ENVIRONMENTS,
        'repo/.abe/settings.local.yaml': [
          'overrides:',
          '  reach:',
          '    value: [ABE_AWS_WRITE_TEST]',
          '    reason: my own migration',
          '',
        ].join('\n'),
      }),
    );
  });
  afterAll(() => done(w));

  test('creds write: no-reach, and no AWS call; env has the reads alone', async () => {
    expect(await w.abe.json(ReachCredsData, 'reach', 'creds', 'test', 'write')).toMatchObject({
      exit: 1,
      doc: {
        ok: false,
        error: { code: 'no-reach', message: 'ABE_AWS_WRITE_TEST is not granted in this repo' },
      },
    });
    expect(w.aws.calls()).toEqual([]);
    const out = await w.abe.json(ReachEnvData, 'reach', 'env', '--target', 'cloud');

    if (!out.doc.ok) throw new Error(out.doc.error.message);
    expect(Object.keys(out.doc.data.env)).toEqual([
      'ABE_AWS_READ_PROD',
      'ABE_AWS_READ_TEST',
      'ABE_DB_READ_URL_TEST',
    ]);
  });
});

describe('abe reach check', () => {
  test("a clean repo's file exits 0", async () => {
    const w = world(shopRepo());

    try {
      expect(await w.abe.json(ReachCheckData, 'reach', 'check', w.f.repo)).toEqual({
        exit: 0,
        stderr: '',
        doc: { ok: true, data: { files: [join(w.f.repo, 'abe.yaml')] } },
      });
      // the folder typed in, from where it is typed
      expect((await w.abe.json(ReachCheckData, 'reach', 'check', '.')).exit).toBe(0);
    } finally {
      await done(w);
    }
  });

  test('exits 1 listing each problem: file, path, reason', async () => {
    const f = tree({
      'repo/abe.yaml': [
        ENVIRONMENTS,
        'reach: [ABE_S3_READ_TEST, ABE_AWS_READ_STAGE, ABE_AWS_WRITE_PROD]',
        'overrides:',
        '  reach:',
        '    value: [ABE_DB_WRITE_URL_TEST]',
        '',
      ].join('\n'),
    });
    const w = world(f);
    const file = join(f.repo, 'abe.yaml');

    try {
      const out = await w.abe.json(ReachCheckData, 'reach', 'check', f.repo);

      expect(out).toMatchObject({ exit: 1, doc: { ok: false, error: { code: 'bad-reach' } } });
      if (out.doc.ok) throw new Error('expected a refusal');
      expect(
        out.doc.error.message.split('\n').map((l) => l.split(': ').slice(0, 2).join(': ')),
      ).toEqual([
        `${file}: overrides.reach.reason`,
        `${file}: reach[0]`,
        `${file}: reach[1]`,
        `${file}: reach[2]`,
      ]);
      const text = await w.abe.run('reach', 'check', f.repo);

      expect(text.exit).toBe(1);
      expect(text.stderr).toContain('ABE_S3_READ_TEST');
      expect(text.stderr).toContain('STAGE is not an environment the repo lists (prod, test)');
      expect(text.stderr).toContain('granted only by an Override with a reason');
      expect(text.stderr).toContain('an Override of reach needs a non-empty reason');
    } finally {
      await done(w);
    }
  });

  test('a folder with no abe.yaml', async () => {
    const w = world(shopRepo());

    try {
      expect(await w.abe.json(ReachCheckData, 'reach', 'check', w.f.mine)).toMatchObject({
        exit: 1,
        doc: { ok: false, error: { code: 'no-layer-files' } },
      });
    } finally {
      await done(w);
    }
  });
});
