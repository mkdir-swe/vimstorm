/** The login secret through a fake `aws`: a value only ever on stdin and stdout, never on argv. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAws, type FakeAws } from '@abe/testing';
import { readFileSync } from 'node:fs';
import { ADO_RESOURCE } from '../azure-devops/az';
import { awsLoginStore, cliLoginTools } from './login-store';

const ARN = 'arn:aws:secretsmanager:eu-west-1:111111111111:secret:abe/octo/logins-AbCdEf';
const VALUE = '{"v":1,"logins":{}}';
let aws: FakeAws | undefined;

afterEach(() => {
  aws?.remove();
});

test('a write hands the value on stdin, in the ARN’s region', async () => {
  aws = fakeAws([['put-secret-value', { stdout: 'v-1\n' }]]);
  const store = awsLoginStore({ PATH: aws.path, HOME: aws.dir });

  expect(await store.write(ARN, VALUE)).toEqual({ ok: true, data: null });
  const [call] = aws.calls();

  expect(call?.stdin).toBe(VALUE);
  expect(call?.argv).toContain('file:///dev/stdin');
  expect(call?.argv.join(' ')).not.toContain(VALUE);
  expect(call?.argv.slice(-2)).toEqual(['--region', 'eu-west-1']);
});

test('a read gives the value and when it was made', async () => {
  aws = fakeAws([
    ['get-secret-value', { json: { text: VALUE, createdAt: '2026-10-23T02:30:00.123000+00:00' } }],
  ]);
  const store = awsLoginStore({ PATH: aws.path, HOME: aws.dir });

  expect(await store.read('abe/octo/logins')).toEqual({
    ok: true,
    data: { text: VALUE, createdAt: '2026-10-23T02:30:00.123000+00:00' },
  });
});

test('no such secret, or no value yet, reads as none', async () => {
  aws = fakeAws([
    [
      'get-secret-value',
      {
        stderr:
          "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret value for staging label: AWSCURRENT",
        exit: 254,
      },
    ],
  ]);
  const store = awsLoginStore({ PATH: aws.path, HOME: aws.dir });

  expect(await store.read('abe/octo/logins')).toEqual({ ok: true, data: null });
});

test('access denied is refused, naming the secret', async () => {
  aws = fakeAws();
  const store = awsLoginStore({ PATH: aws.path, HOME: aws.dir });
  const read = await store.read('abe/someone/logins');

  expect(read.ok).toBe(false);
  expect(!read.ok && read.error.message).toContain(
    'abe/someone/logins: An error occurred (AccessDenied)',
  );
});

test("#160: a login tool not on serve's PATH can't be checked; a claude failing on its model neither", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-check-'));

  try {
    writeFileSync(
      join(dir, 'claude'),
      [
        '#!/bin/sh',
        // Its version answers (sessions would run it); its status fails on the selected model.
        'case "$1" in --version) echo "2.1.310 (Claude Code)"; exit 0;; esac',
        'echo "There\'s an issue with the selected model (fable)." >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'claude'), 0o755);
    const tools = cliLoginTools({ env: { PATH: `${dir}:/usr/bin:/bin` }, home: dir });

    expect(await tools.check('github')).toEqual({ cannot: "gh not found on serve's PATH" });
    expect(await tools.check('az')).toEqual({ cannot: "az not found on serve's PATH" });
    expect(await tools.check('claude')).toEqual({
      cannot: "claude auth status failed: There's an issue with the selected model (fable).",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#190: the claude login checked is the one sessions run, not an older one first on PATH', async () => {
  const old = mkdtempSync(join(tmpdir(), 'claude-old-'));
  const current = mkdtempSync(join(tmpdir(), 'claude-new-'));
  const script = (version: string, status: string) =>
    [
      '#!/bin/sh',
      `case "$1" in --version) echo "${version} (Claude Code)"; exit 0;; esac`,
      status,
      '',
    ].join('\n');

  try {
    writeFileSync(join(old, 'claude'), script('2.1.39', 'echo "model issue" >&2; exit 1'));
    writeFileSync(join(current, 'claude'), script('2.1.310', `echo '{"loggedIn":true}'`));
    chmodSync(join(old, 'claude'), 0o755);
    chmodSync(join(current, 'claude'), 0o755);
    const tools = cliLoginTools({
      env: { PATH: `${old}:${current}:/usr/bin:/bin` },
      home: old,
    });

    expect(await tools.check('claude')).toEqual({ works: true });
  } finally {
    rmSync(old, { recursive: true, force: true });
    rmSync(current, { recursive: true, force: true });
  }
});

test('#345: each check says who its login works as, never more of it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-who-'));
  const put = (name: string, body: string) => {
    writeFileSync(join(dir, name), ['#!/bin/sh', body, ''].join('\n'));
    chmodSync(join(dir, name), 0o755);
  };

  try {
    put(
      'gh',
      [
        'echo "github.com"',
        'echo "  ✓ Logged in to github.com account octocat (keyring)"',
        'echo "  - Token: gho_************************************"',
      ].join('\n'),
    );
    put(
      'claude',
      [
        'case "$1" in --version) echo "2.1.310 (Claude Code)"; exit 0;; esac',
        `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"octo@example.com"}'`,
      ].join('\n'),
    );
    const tools = cliLoginTools({ env: { PATH: `${dir}:/usr/bin:/bin` }, home: dir });

    expect(await tools.check('github')).toEqual({ works: true, who: 'octocat' });
    expect(await tools.check('claude')).toEqual({ works: true, who: 'octo@example.com' });
    // What `az account show --query user.name -o tsv` answers → the row's account: only a name,
    // never az's raw output (a shim answering token JSON, a bare token).
    const fake = '{"accessToken":"fake-token","expiresOn":"2099-01-01","tokenType":"Bearer"}';
    const rows: [string, string][] = [
      ['echo "octo@example.com"', 'octo@example.com'],
      [`echo '${fake}'`, "can't read the account"],
      ['echo eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.e30.c2ln', "can't read the account"],
      ['printf "octo\\nsecond line\\n"', "can't read the account"],
    ];

    for (const [show, who] of rows) {
      put(
        'az',
        [
          'case "$2" in',
          `  show) ${show};;`,
          '  get-access-token) echo "2026-10-25 12:00:00.000000";;',
          'esac',
        ].join('\n'),
      );
      expect([show, await tools.check('az')]).toEqual([show, { works: true, who }]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("az's check asks for an Azure DevOps token, prints only its end, and says why it failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-az-'));
  const argv = join(dir, 'argv');
  const put = (token: string) => {
    writeFileSync(
      join(dir, 'az'),
      [
        '#!/bin/sh',
        'case "$2" in',
        '  show) echo ada@example.com;;',
        `  get-access-token) echo "$*" > ${argv}; ${token};;`,
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'az'), 0o755);
  };
  const tools = cliLoginTools({ env: { PATH: `${dir}:/usr/bin:/bin` }, home: dir });
  const long = 'x'.repeat(201);
  const rows: [string, string, Awaited<ReturnType<typeof tools.check>>][] = [
    [
      'a tenant-level login: the board token works',
      'echo 2099-01-01',
      { works: true, who: 'ada@example.com' },
    ],
    [
      'no login: its first line',
      `printf '\\nERROR: Please run az login to setup account.\\nmore\\n' >&2; exit 1`,
      { works: false, said: 'ERROR: Please run az login to setup account.' },
    ],
    [
      'a line with a token in it: none',
      'echo "ERROR: eyJ0eXAi.e30.c2ln" >&2; exit 1',
      { works: false },
    ],
    ['a long line: none', `echo ${long} >&2; exit 1`, { works: false }],
    [
      "Entra's refusal: named, as it was",
      'echo "AADSTS53003: Access has been blocked by Conditional Access policies." >&2; exit 1',
      { works: false, blocked: 'AADSTS53003' },
    ],
  ];

  try {
    for (const [name, token, want] of rows) {
      put(token);
      expect([name, await tools.check('az')]).toEqual([name, want]);
      expect(readFileSync(argv, 'utf8').trim()).toBe(
        `account get-access-token --resource ${ADO_RESOURCE} --query expiresOn --output tsv`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
