/**
 * A repo's logins (`logins:`) and aws stored like the others, through the CLI seam: the real
 * `abe` and a detached `serve` with fake `gh`, `claude`, `az` and `aws` on `PATH` and a folder
 * standing in for Secrets Manager. On the Mac `abe login aws --profile` signs in to the person's
 * own SSO profile and stores only that profile for their boxes (a profile with an IAM user's keys
 * is only checked: nothing to sign in to or store); a box restores it, reports the
 * repo's logins against it, and signs in again with a device code when it has expired.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AWS_LOGIN_HOME, LoginData, LoginDoc, LoginStatusData } from '@abe/core';
import { cli, type Cli, FAKE_AWS_TOKEN, fakeLoginClis, type FakeLoginClis } from '@abe/testing';

const SECRET = 'abe/octo/logins';

/** SSO's cache file for the profile's own session, `corp`: its SHA-1, as aws names it. */
const CORP = createHash('sha1').update('corp').digest('hex');
const CORP_FILE = `.aws/sso/cache/${CORP}.json`;
/** Another SSO session's token in the same cache: never leaves the Mac. */
const OTHER_TOKEN = 'aoaAAAAAGotherSESSIONotherSESSION0002';

const MY_CONFIG = [
  '[default]',
  'region = us-east-1',
  '',
  '[profile shop-test]',
  'sso_session = corp',
  'sso_account_id = 111111111111',
  'sso_role_name = Dev',
  '',
  '[sso-session corp]',
  'sso_start_url = https://corp.awsapps.com/start',
  'sso_region = eu-west-1',
  '',
  '[profile personal]',
  'region = us-east-1',
  '',
  '[profile loose]',
  'sso_account_id = 222222222222',
  '',
].join('\n');

let clis: FakeLoginClis;
let store: string;
let repo: string;

const secretPath = (name: string) => join(store, ...name.split('/'));
const stored = () => LoginDoc.parse(JSON.parse(readFileSync(secretPath(SECRET), 'utf8')));
const b64 = (text: string | undefined) => Buffer.from(text ?? '', 'base64').toString('utf8');

beforeAll(() => {
  clis = fakeLoginClis();
  store = mkdtempSync(join(tmpdir(), 'secrets-'));
  repo = mkdtempSync(join(tmpdir(), 'shop-'));
  Bun.spawnSync(['git', 'init', '-q', repo]);
  mkdirSync(join(repo, '.abe'));
  writeFileSync(
    join(repo, 'abe.yaml'),
    'logins:\n  - gh\n  - aws: { profile: shop-test, sso: true }\n',
  );
});

afterAll(() => {
  clis.remove();
  for (const dir of [store, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('on the Mac: aws signed in for the boxes', () => {
  let abe: Cli;

  beforeAll(() => {
    abe = cli({
      env: {
        PATH: clis.path,
        ABE_LOGINS_STORE: `file://${store}`,
        ABE_OWNER: 'octo',
        ABE_FAKE_AWS_CACHE: CORP,
      },
    });
    mkdirSync(join(abe.state.dir, '.aws', 'sso', 'cache'), { recursive: true });
    writeFileSync(join(abe.state.dir, '.aws', 'config'), MY_CONFIG);
    writeFileSync(
      join(abe.state.dir, '.aws', 'sso', 'cache', `${'e'.repeat(40)}.json`),
      `{"accessToken":"${OTHER_TOKEN}"}`,
    );
  });
  afterAll(async () => {
    await abe.close();
  });

  test.each([
    ['no --profile', ['login', 'aws'], 'abe login aws needs --profile'],
    [
      '--profile on another tool',
      ['login', 'claude', '--profile', 'x'],
      '--profile is for aws only',
    ],
  ])('refused: %s', async (_, argv, words) => {
    const out = await abe.run(...argv);

    expect(out.exit).toBe(2);
    expect(out.stderr).toContain(words);
  });

  test.each([
    ['a profile not in your config', 'nope', 'no [profile nope] in your aws config'],
    [
      'a profile whose SSO token is no one file',
      'loose',
      "can't tell which SSO token is [profile loose]'s",
    ],
  ])('refused, nothing stored: %s', async (_, profile, words) => {
    const out = await abe.run('login', 'aws', '--profile', profile);

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain(words);
    expect(existsSync(secretPath(SECRET))).toBe(false);
  });

  test('abe login aws --profile stores that profile and its SSO token, nothing else', async () => {
    const { exit, doc } = await abe.json(LoginData, 'login', 'aws', '--profile', 'shop-test');

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        tool: 'aws',
        secret: SECRET,
        files: ['.aws/config', CORP_FILE],
        from: 'mac',
      },
    });
    const aws = stored().logins.aws?.files ?? {};

    expect(b64(aws['.aws/config'])).toBe(
      [
        '[profile shop-test]',
        'sso_session = corp',
        'sso_account_id = 111111111111',
        'sso_role_name = Dev',
        '',
        '[sso-session corp]',
        'sso_start_url = https://corp.awsapps.com/start',
        'sso_region = eu-west-1',
        '',
      ].join('\n'),
    );
    // only the profile's own session's token: another session's never leaves the Mac
    expect(Object.keys(aws)).toEqual(['.aws/config', CORP_FILE]);
    expect(b64(aws[CORP_FILE])).toContain(FAKE_AWS_TOKEN);
    for (const f of Object.values(aws)) expect(b64(f)).not.toContain(OTHER_TOKEN);
  });

  test("abe login status --repo: the repo's needs, aws checked for its profile", async () => {
    const { doc } = await abe.json(LoginStatusData, 'login', 'status', '--repo', repo);

    expect(doc.ok && doc.data.repo).toMatchObject({
      needs: [
        { tool: 'github', name: 'gh', state: 'missing', fix: 'gh auth login --web' },
        { tool: 'aws', profile: 'shop-test', state: 'ok', who: 'ada@example.com', fix: null },
      ],
      missing: ['github'],
      ready: false,
    });
  });
});

describe("on the Mac: a profile with an IAM user's keys, no Identity Center", () => {
  let abe: Cli;
  let keysRepo: string;

  beforeAll(() => {
    abe = cli({
      env: { PATH: clis.path, ABE_LOGINS_STORE: `file://${store}`, ABE_OWNER: 'octo' },
    });
    mkdirSync(join(abe.state.dir, '.aws'), { recursive: true });
    writeFileSync(join(abe.state.dir, '.aws', 'config'), '[profile own]\nregion = eu-west-1\n');
    writeFileSync(
      join(abe.state.dir, '.aws', 'credentials'),
      '[own]\naws_access_key_id = AKIAFAKEFAKEFAKE\naws_secret_access_key = fake\n',
    );
    keysRepo = mkdtempSync(join(tmpdir(), 'own-'));
    Bun.spawnSync(['git', 'init', '-q', keysRepo]);
    mkdirSync(join(keysRepo, '.abe'));
    writeFileSync(join(keysRepo, 'abe.yaml'), 'logins:\n  - aws: { profile: own }\n');
  });
  afterAll(async () => {
    await abe.close();
    rmSync(keysRepo, { recursive: true, force: true });
  });

  test('abe login status: aws ok for it, as the IAM user', async () => {
    const { doc } = await abe.json(LoginStatusData, 'login', 'status', '--repo', keysRepo);

    expect(doc.ok && doc.data.repo).toMatchObject({
      needs: [{ tool: 'aws', profile: 'own', state: 'ok', who: 'ada', fix: null }],
      ready: true,
    });
  });

  test('abe login aws --profile: its keys checked, no SSO login, nothing stored', async () => {
    const before = existsSync(secretPath(SECRET)) ? readFileSync(secretPath(SECRET), 'utf8') : null;
    const { exit, doc } = await abe.json(LoginData, 'login', 'aws', '--profile', 'own');

    expect(exit).toBe(0);
    expect(doc).toMatchObject({ ok: true, data: { tool: 'aws', secret: null, files: [] } });
    expect(clis.calls().filter((c) => c.includes('sso login --profile own'))).toEqual([]);
    expect(existsSync(secretPath(SECRET)) ? readFileSync(secretPath(SECRET), 'utf8') : null).toBe(
      before,
    );
  });

  test('keys that no longer resolve: refused with aws configure, the IAM way in', async () => {
    writeFileSync(
      join(abe.state.dir, '.aws', 'credentials'),
      '[own]\naws_access_key_id = AKIAexpired\naws_secret_access_key = fake\n',
    );
    const out = await abe.run('login', 'aws', '--profile', 'own');

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain('aws configure --profile own');
  });
});

describe('on a box: aws restored, checked and signed in again', () => {
  let abe: Cli;

  beforeAll(() => {
    abe = cli({
      env: {
        PATH: clis.path,
        ABE_LOGINS_SECRET: SECRET,
        ABE_LOGINS_STORE: `file://${store}`,
        ABE_FAKE_AWS_CACHE: CORP,
      },
    });
  });
  afterAll(async () => {
    await abe.close();
  });

  /** The box's aws login, in a HOME of its own (`AWS_LOGIN_HOME`), apart from Reach's ~/.aws. */
  const awsHome = () => join(abe.state.dir, AWS_LOGIN_HOME);
  const cache = () => join(awsHome(), CORP_FILE);
  const REACH_CONFIG =
    '[profile abe-read-test]\ncredential_process = abe reach creds ABE_AWS_READ_TEST\n';

  test("a new box restores aws and the repo's aws is ok", async () => {
    // Reach's config for box sessions, written before the restore
    mkdirSync(join(abe.state.dir, '.aws'), { recursive: true });
    writeFileSync(join(abe.state.dir, '.aws', 'config'), REACH_CONFIG);
    const { doc } = await abe.json(LoginStatusData, 'login', 'status', '--repo', repo);

    expect(doc.ok && doc.data.logins.aws).toBe('ok');
    expect(doc.ok && doc.data.repo?.missing).toEqual(['github']);
    const mine = readFileSync(join(awsHome(), '.aws', 'config'), 'utf8');

    expect(mine).toContain('[profile shop-test]');
    expect(mine).not.toContain('[default]');
    // Reach's config is never overwritten, nor its SSO folder given your token
    expect(readFileSync(join(abe.state.dir, '.aws', 'config'), 'utf8')).toBe(REACH_CONFIG);
    expect(existsSync(join(abe.state.dir, CORP_FILE))).toBe(false);
  });

  test('an expired SSO token is expired, its fix the device-code login', async () => {
    writeFileSync(cache(), '{"accessToken":"x","expired":true}');
    const out = await abe.run('login', 'status', '--repo', repo);

    expect(out.stdout).toContain('  aws (shop-test)  expired  (abe login aws --profile shop-test)');
  });

  test('abe login aws --profile signs in with a device code and stores it', async () => {
    mkdirSync(dirname(cache()), { recursive: true });
    const out = await abe.run('login', 'aws', '--profile', 'shop-test');

    expect(out.exit).toBe(0);
    expect(out.stderr).toContain('FAKE-CODE');
    expect(b64(stored().logins.aws?.files[CORP_FILE])).toContain(FAKE_AWS_TOKEN);
    const { doc } = await abe.json(LoginStatusData, 'login', 'status', '--repo', repo);

    expect(doc.ok && doc.data.repo?.needs.find((n) => n.tool === 'aws')?.state).toBe('ok');
    const log = readFileSync(join(abe.state.dir, 'serve.log'), 'utf8');

    expect(log).not.toContain(FAKE_AWS_TOKEN);
  });
});
