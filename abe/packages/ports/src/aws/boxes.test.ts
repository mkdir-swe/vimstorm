/**
 * The Boxes port (ADR 0021) through the real `awsRunner` and a fake `aws` that answers EC2 as the
 * CLI does, IAM's ABAC (the org Terraform's abe-developer-boxes) in front: only boxes tagged `abe:owner`
 * with the caller's login are theirs to start, stop and resize, and a box is made only from the
 * launch template with the caller's own box role.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX_LAUNCH_TEMPLATE, type Answered, type Boxes } from '@abe/core';
import { fakeEc2, type FakeEc2, fakeGh, ghUser } from '@abe/testing';
import { z } from 'zod';
import { awsRunner } from './aws';
import {
  awsFailure,
  boxAwsReach,
  boxAwsEnvAs,
  boxOwnerFrom,
  boxProfileOf,
  ec2Boxes,
} from './boxes';

let ec2: FakeEc2;
let boxes: Boxes;

const make = (owner: string, profile: string | null = 'abe-tooling') =>
  ec2Boxes({
    aws: awsRunner({ PATH: ec2.path, HOME: ec2.dir }),
    owner: () => Promise.resolve({ ok: true, data: owner }),
    profile,
    region: 'eu-west-1',
  });

const data = <T>(a: Answered<T>): T => {
  if (!a.ok) throw new Error(`${a.error.code}: ${a.error.message}`);

  return a.data;
};

const until = async (what: string, check: () => boolean) => {
  const end = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const SPEC = {
  name: 'demo-shop-4',
  repo: 'mkdir-swe/demo-shop',
};

beforeEach(() => {
  ec2 = fakeEc2({ owner: 'octocat', bootMs: 600, stopMs: 600 });
  boxes = make('octocat');
});
afterEach(() => {
  ec2.remove();
});

describe('ec2Boxes: the person’s boxes on EC2', () => {
  test('up makes the repo’s box from the launch template: its tags (no card, ADR 0022), its volume’s, the owner’s role', async () => {
    const made = data(await boxes.up(SPEC));

    expect(made).toMatchObject({
      name: 'demo-shop-4',
      owner: 'octocat',
      state: 'pending',
      size: 'm8g.large',
      repo: 'mkdir-swe/demo-shop',
      card: null,
      zone: 'eu-west-1a',
    });
    const run = ec2.calls().find((c) => c.startsWith('ec2 run-instances')) ?? '';

    expect(run).toContain(`--launch-template LaunchTemplateName=${BOX_LAUNCH_TEMPLATE}`);
    expect(run).toContain('--iam-instance-profile Name=abe-box-octocat-boxes');
    const specs = z
      .array(
        z.object({
          ResourceType: z.string(),
          Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
        }),
      )
      .parse(JSON.parse(/--tag-specifications (\[.*\]) --region/.exec(run)?.[1] ?? '[]'));
    const tags = (type: string) =>
      Object.fromEntries(
        (specs.find((s) => s.ResourceType === type)?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );

    expect(tags('instance')).toMatchObject({
      'abe:owner': 'octocat',
      'abe:box': 'demo-shop-4',
      'abe:repo': 'mkdir-swe/demo-shop',
      project: 'abe',
    });
    expect(tags('instance')['abe:card']).toBeUndefined();
    expect(tags('instance')['abe:title']).toBeUndefined();
    expect(tags('instance')['abe:team']).toBeUndefined();
    expect(tags('volume')).toMatchObject({ 'abe:owner': 'octocat', 'abe:box': 'demo-shop-4' });
    expect(tags('volume')['abe:team']).toBeUndefined();
    await until('running', () => ec2.instance('demo-shop-4')?.State === 'running');
    expect(data(await boxes.status('demo-shop-4'))?.state).toBe('running');
  });

  test('up again: the same box, never a second; a stopped one is started', async () => {
    data(await boxes.up(SPEC));
    await until('running', () => ec2.instance('demo-shop-4')?.State === 'running');
    expect(data(await boxes.up(SPEC)).state).toBe('running');
    expect(data(await boxes.stop('demo-shop-4')).state).toBe('stopping');
    await until('stopped', () => ec2.instance('demo-shop-4')?.State === 'stopped');
    expect(data(await boxes.up(SPEC)).state).toBe('pending');
    expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toHaveLength(1);
    expect(ec2.calls().filter((c) => c.startsWith('ec2 start-instances'))).toHaveLength(1);
  });

  test('up while it stops: box-busy, nothing made', async () => {
    ec2.put({ name: 'demo-shop-4', state: 'stopping' });
    ec2.hold('demo-shop-4', true);
    const up = await boxes.up(SPEC);

    expect(up).toMatchObject({ ok: false, error: { code: 'box-busy' } });
    expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toHaveLength(0);
  });

  test('start wakes a stopped box and never makes one: none, or a terminated one, is no-box', async () => {
    ec2.put({ name: 'demo-shop-4', state: 'stopped' });
    expect(data(await boxes.start('demo-shop-4')).state).toBe('pending');
    expect(await boxes.start('demo-shop-5')).toMatchObject({
      ok: false,
      error: { code: 'no-box' },
    });
    ec2.put({ name: 'demo-shop-6', state: 'terminated' });
    expect(await boxes.start('demo-shop-6')).toMatchObject({
      ok: false,
      error: { code: 'no-box' },
    });
    expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toHaveLength(0);
  });

  test('a name is one box: a comma in it (EC2 reads Values=a,b as a or b) matches none', async () => {
    ec2.put({ name: 'demo-shop-4', state: 'running' });
    expect(data(await boxes.status('demo-shop-4,demo-shop-5'))).toBeNull();
    expect(await boxes.stop('demo-shop-9,demo-shop-4')).toMatchObject({
      ok: false,
      error: { code: 'no-box' },
    });
    expect(ec2.instance('demo-shop-4')?.State).toBe('running');
  });

  test('a terminated box of the name is as none: up makes a new one', async () => {
    ec2.put({ name: 'demo-shop-4', state: 'terminated' });
    expect(data(await boxes.status('demo-shop-4'))).toBeNull();
    expect(data(await boxes.up(SPEC)).state).toBe('pending');
    expect(data(await boxes.list()).map((b) => [b.name, b.state])).toEqual([
      ['demo-shop-4', 'pending'],
    ]);
  });

  test('list: only your own boxes, by name; another owner’s never shows', async () => {
    ec2.put({ name: 'shop-9', card: 9, repo: 'o/shop' });
    ec2.put({ name: 'shop-2', state: 'stopped' });
    ec2.put({ name: 'shop-1', owner: 'hubot' });
    expect(data(await boxes.list()).map((b) => [b.name, b.owner, b.state, b.card])).toEqual([
      ['shop-2', 'octocat', 'stopped', null],
      ['shop-9', 'octocat', 'running', 9],
    ]);
    expect(data(await boxes.status('shop-1'))).toBeNull();
    expect(await boxes.stop('shop-1')).toMatchObject({ ok: false, error: { code: 'no-box' } });
  });

  test('resize: a stopped box’s instance type; a running one is box-busy', async () => {
    ec2.put({ name: 'shop-2', state: 'running' });
    expect(await boxes.resize('shop-2', 'm8g.xlarge')).toMatchObject({
      ok: false,
      error: { code: 'box-busy' },
    });
    ec2.set('shop-2', 'stopped');
    expect(data(await boxes.resize('shop-2', 'm8g.xlarge')).size).toBe('m8g.xlarge');
    expect(ec2.instance('shop-2')?.InstanceType).toBe('m8g.xlarge');
  });

  test('list: LaunchTime (reset on each start), the launch template version, the card’s title', async () => {
    const launched = Date.parse('2026-10-24T08:00:00Z');

    ec2.put({ name: 'shop-2', release: 9, launchedAt: launched, title: 'Pay by card' });
    ec2.put({ name: 'shop-3', state: 'stopped', launchedAt: launched });
    expect(data(await boxes.list()).map((b) => [b.name, b.launchedAt, b.release, b.title])).toEqual(
      [
        ['shop-2', '2026-10-24T08:00:00.000Z', 9, 'Pay by card'],
        ['shop-3', '2026-10-24T08:00:00.000Z', null, null],
      ],
    );
    // Made from the launch template: EC2 tags it with the template's version (11 in the fake).
    expect(data(await boxes.up(SPEC)).release).toBe(11);
    // A start is a new LaunchTime.
    const before = Date.now();

    data(await boxes.start('shop-3'));
    const started = data(await boxes.status('shop-3'));

    expect(Date.parse(started?.launchedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
  });

  test('terminate: EC2 TerminateInstances as you, shutting-down, then gone from the list', async () => {
    ec2.lead(true);
    ec2.put({ name: 'shop-2', state: 'stopped' });
    expect(data(await boxes.terminate('shop-2')).state).toBe('shutting-down');
    expect(ec2.calls().filter((c) => c.startsWith('ec2 terminate-instances'))).toHaveLength(1);
    await until('terminated', () => ec2.instance('shop-2')?.State === 'terminated');
    expect(data(await boxes.list())).toEqual([]);
    expect(await boxes.terminate('shop-2')).toMatchObject({ ok: false, error: { code: 'no-box' } });
  });

  test('terminate refused by IAM (ABAC: only a lead terminates): said as such, the box kept', async () => {
    ec2.put({ name: 'shop-2' });
    expect(await boxes.terminate('shop-2')).toEqual({
      ok: false,
      error: {
        code: 'terminate-refused',
        message: 'Terminate refused: only your lead can terminate boxes',
      },
    });
    expect(ec2.instance('shop-2')?.State).toBe('running');
  });

  test('stop: asked, then stopping; stopped already is fine and asks nothing', async () => {
    ec2.put({ name: 'shop-2', state: 'stopped' });
    expect(data(await boxes.stop('shop-2')).state).toBe('stopped');
    expect(ec2.calls().filter((c) => c.startsWith('ec2 stop-instances'))).toHaveLength(0);
    expect(await boxes.stop('nope-1')).toMatchObject({ ok: false, error: { code: 'no-box' } });
  });
});

describe('refusals', () => {
  test('IAM refuses another owner’s box (ABAC): aws-refused, said in words', async () => {
    // A person naming another login: they see that login's boxes, but IAM knows who they are.
    ec2.put({ name: 'shop-1', owner: 'hubot' });
    const posing = make('hubot');

    for (const asked of [
      await posing.stop('shop-1'),
      await posing.up({ ...SPEC, name: 'shop-7' }),
    ]) {
      expect(asked.ok).toBe(false);
      if (asked.ok) continue;
      expect(asked.error.code).toBe('aws-refused');
      expect(asked.error.message).toContain('UnauthorizedOperation');
      expect(asked.error.message).not.toContain('Encoded authorization failure message');
    }
    ec2.set('shop-1', 'stopped');
    expect(await posing.resize('shop-1', 'm8g.xlarge')).toMatchObject({
      ok: false,
      error: { code: 'aws-refused' },
    });
    expect(ec2.instance('shop-1')?.InstanceType).toBe('m8g.large');
  });

  test('an expired SSO login: aws-auth, naming the profile to log in with', async () => {
    ec2.expire(true);
    const listed = await boxes.list();

    expect(listed).toMatchObject({
      ok: false,
      error: { code: 'aws-auth', profile: 'abe-tooling' },
    });
    expect(!listed.ok && listed.error.message).toContain('aws sso login --profile abe-tooling');
  });

  test('no login to read the owner from: its refusal, asked again next time', async () => {
    let asked = 0;
    const port = ec2Boxes({
      aws: awsRunner({ PATH: ec2.path }),
      owner: () => {
        asked += 1;

        return Promise.resolve(
          asked === 1
            ? { ok: false, error: { code: 'gh-auth', message: 'gh is not logged in' } }
            : { ok: true, data: 'octocat' },
        );
      },
    });

    expect(await port.list()).toMatchObject({ ok: false, error: { code: 'gh-auth' } });
    expect(data(await port.list())).toEqual([]);
    expect(data(await port.list())).toEqual([]);
    expect(asked).toBe(2);
  });

  test.each([
    ['UnauthorizedOperation', 'aws-refused'],
    ['Error loading SSO Token: Token for x does not exist', 'aws-auth'],
    ['Could not connect to the endpoint URL', 'aws-failed'],
  ])('%s → %s', (said, code) => {
    expect(awsFailure(`An error occurred (${said}) when calling`, null).error.code).toBe(code);
  });
});

describe('#344: no profile and no credentials: the profile is what is missing', () => {
  test('in words, with the setting that fixes it; a named profile is a login to make', () => {
    const said =
      'Unable to locate credentials. You can configure credentials by running "aws configure".';

    expect(awsFailure(said, null).error).toEqual({
      code: 'aws-profile',
      message:
        "no AWS profile reaches your boxes: abe settings set box.profile <profile> (the AWS profile of your boxes' account, as ~/.aws/config names it) and abe serve stop, then sign in to it (aws sso login --profile <profile>, or aws configure --profile <profile> for an IAM user's keys)",
    });
    expect(awsFailure(said, 'abe-tooling').error.code).toBe('aws-auth');
    // a profile with an IAM user's keys signs in again with aws configure
    const keys = awsFailure(said, 'own', true).error;

    expect(keys).toMatchObject({ code: 'aws-auth', keys: true });
    expect(keys.message).toEndWith('run `aws configure --profile own`');
  });
});

describe('#294: no AWS region says what is missing and the fix, in Abe’s words', () => {
  const said =
    'You must specify a region. You can also configure your region by running "aws configure".';

  test.each([
    [
      'abe-play',
      "no AWS region for profile abe-play: abe settings set box.region <region> (your boxes' region) then abe serve stop, or add region to that profile in ~/.aws/config",
    ],
    [
      null,
      "no AWS region for the default profile: abe settings set box.region <region> (your boxes' region) then abe serve stop, or add region to it in ~/.aws/config",
    ],
  ])('profile %p', (profile, message) => {
    expect(awsFailure(said, profile)).toEqual({
      ok: false,
      error: { code: 'aws-region', message },
    });
  });
});

describe('#158: the AWS profile and region boxes are reached on, as aws finds them', () => {
  const config = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-config-'));

    writeFileSync(join(dir, 'config'), text);

    return { dir, file: join(dir, 'config') };
  };

  test.each([
    ['nothing named, no config', {}, null, { profile: null, region: null }],
    [
      'the default profile when none is named: [default] and its region',
      {},
      '[default]\nregion = eu-north-1\n',
      { profile: 'default', region: 'eu-north-1' },
    ],
    [
      '[profile default] counts as default',
      {},
      '[profile default]\nregion=eu-west-1\n',
      { profile: 'default', region: 'eu-west-1' },
    ],
    [
      "the named profile's region, not the default's",
      { AWS_PROFILE: 'abe-dev' },
      '[default]\nregion = us-east-1\n[sso-session abe]\nsso_region = eu-north-1\n[profile abe-dev]\nsso_session = abe\nregion = eu-north-1\n',
      { profile: 'abe-dev', region: 'eu-north-1' },
    ],
    [
      '$AWS_REGION over the config; a named profile with no region in it',
      { ABE_BOX_PROFILE: 'boxes', AWS_REGION: 'ap-south-1' },
      '[profile boxes]\n',
      { profile: 'boxes', region: 'ap-south-1' },
    ],
    [
      'a named profile without its region',
      { AWS_PROFILE: 'abe-dev' },
      '[profile abe-dev]\nsso_session = abe\n',
      { profile: 'abe-dev', region: null },
    ],
  ] as const)('%s', (_, env, text, reach) => {
    const at = text === null ? undefined : config(text);

    try {
      expect(
        boxAwsReach({ ...env, AWS_CONFIG_FILE: at?.file ?? '/nonexistent/config' }, '/nonexistent'),
      ).toEqual(reach);
    } finally {
      if (at !== undefined) rmSync(at.dir, { recursive: true, force: true });
    }
  });
});

describe('#242: whose boxes, from gh: one line naming the fix when gh has no login there', () => {
  const GH_NO_LOGIN = {
    stderr:
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
    exit: 4,
  };

  test("gh's login, when it has one", async () => {
    const gh = fakeGh([['api user', { json: ghUser('octocat') }]]);

    try {
      expect(await boxOwnerFrom({ PATH: gh.path, HOME: '/home/a' })()).toEqual({
        ok: true,
        data: 'octocat',
      });
    } finally {
      gh.remove();
    }
  });

  test('$ABE_OWNER is the owner: gh is never asked', async () => {
    const gh = fakeGh([['api user', GH_NO_LOGIN]]);

    try {
      expect(await boxOwnerFrom({ PATH: gh.path, ABE_OWNER: 'octocat' })()).toEqual({
        ok: true,
        data: 'octocat',
      });
      expect(gh.calls()).toEqual([]);
    } finally {
      gh.remove();
    }
  });

  test("no login: one line, naming the folder gh read and the fix, not gh's two", async () => {
    const gh = fakeGh([['api user', GH_NO_LOGIN]]);
    const env = { PATH: gh.path, HOME: '/home/a' };

    try {
      const said = (e: Record<string, string>) =>
        boxOwnerFrom(e)().then((a) => (a.ok ? a.data : `${a.error.code}: ${a.error.message}`));

      expect(await said(env)).toBe(
        'auth: gh has no working GitHub login in /home/a/.config/gh, and your boxes are found by it: run gh auth login (or set ABE_OWNER)',
      );
      // An XDG_CONFIG_HOME pointing somewhere else (a Neovim's) is named, so the line shows why.
      expect(
        await said({
          ...env,
          XDG_CONFIG_HOME: '/home/a/Library/Application Support/VimStorm/config',
        }),
      ).toContain('login in /home/a/Library/Application Support/VimStorm/config/gh,');
      expect(await said({ ...env, GH_CONFIG_DIR: '/tmp/gh-x' })).toContain('login in /tmp/gh-x,');
    } finally {
      gh.remove();
    }
  });

  test('another gh failure: its first line, after what it was asked for', async () => {
    const gh = fakeGh([
      [
        'api user',
        { stderr: 'error connecting to api.github.com\ncheck your internet connection', exit: 1 },
      ],
    ]);

    try {
      const got = await boxOwnerFrom({ PATH: gh.path, HOME: '/home/a' })();

      expect(got.ok ? got.data : got.error.message).toBe(
        'gh could not say your GitHub login, which finds your boxes: error connecting to api.github.com',
      );
    } finally {
      gh.remove();
    }
  });
});

describe("#338: the attach reaches boxes on serve's profile and region, never the caller's", () => {
  test('an empty environment (VimStorm from the Dock) gets them', () => {
    const env = boxAwsEnvAs({ HOME: '/h' }, { profile: 'abe-play', region: 'eu-north-1' });

    expect(env).toEqual({ HOME: '/h', AWS_PROFILE: 'abe-play', AWS_REGION: 'eu-north-1' });
    expect(boxProfileOf(env)).toBe('abe-play');
  });

  test("a terminal's own profile and region are replaced; one serve has none of stays its own", () => {
    const own = {
      HOME: '/h',
      AWS_PROFILE: 'other',
      ABE_BOX_PROFILE: 'other',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
    };

    expect(boxAwsEnvAs(own, { profile: 'abe-play', region: 'eu-north-1' })).toEqual({
      HOME: '/h',
      AWS_PROFILE: 'abe-play',
      AWS_REGION: 'eu-north-1',
    });
    expect(boxAwsEnvAs(own, { profile: null, region: null })).toEqual(own);
    expect(boxAwsEnvAs(own, { profile: 'abe-play', region: null })).toEqual({
      HOME: '/h',
      AWS_PROFILE: 'abe-play',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
    });
  });
});
