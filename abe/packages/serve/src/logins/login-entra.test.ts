/**
 * `abe login az` where Microsoft Entra refuses a device-code sign-in from a box (#237): the real
 * `abe` and a detached `serve` with a fake `az` and a folder standing in for Secrets Manager. On a
 * box the refusal (`AADSTS530035`) is named in plain words with what to do; on the Mac `az`'s own
 * browser login runs in a folder of its own and is stored in the person's secret for their boxes,
 * never touching `~/.azure`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LoginData, LoginDoc, LoginStatusData } from '@abe/core';
import { cli, type Cli, FAKE_AZ_TOKEN } from '@abe/testing';

const SECRET = 'abe/octo/logins';

/**
 * `az`: a device-code login prints the code then Entra's refusal; a browser login writes its
 * files into `$AZURE_CONFIG_DIR` and says where and with what (or is refused with
 * `$FAKE_AZ_BLOCK`); the token check is refused by Conditional Access.
 */
const AZ = `#!/bin/sh
case "$*" in
  *"--use-device-code"*)
    echo "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FAKECODE to authenticate." >&2
    echo "AADSTS530035: Access has been blocked by security defaults. This is due to the request using device code flow, which has been deemed unsafe by your admin. Trace ID: 00000000" >&2
    exit 1;;
  *"login"*)
    if [ -n "$FAKE_AZ_BLOCK" ]; then echo "ERROR: AADSTS53003: Access has been blocked by Conditional Access policies." >&2; exit 1; fi
    echo "$AZURE_CONFIG_DIR" > "$FAKE_AZ_LOG/dir"; echo "$*" > "$FAKE_AZ_LOG/argv"
    d="$AZURE_CONFIG_DIR"; mkdir -p "$d"
    echo '{"subscriptions":[]}' > "$d/azureProfile.json"
    printf '{"AccessToken":{"x":{"secret":"${FAKE_AZ_TOKEN}"}}}' > "$d/msal_token_cache.json"
    echo '[AzureCloud]' > "$d/clouds.config"
    echo "A web browser has been opened at https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize." >&2;;
  *"account get-access-token"*)
    echo "ERROR: AADSTS53003: Access has been blocked by Conditional Access policies. The access policy does not allow token issuance." >&2; exit 1;;
  *) exit 2;;
esac
`;

let bin: string;
let store: string;
let log: string;

const secretPath = (name: string) => join(store, ...name.split('/'));

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'entra-az-'));
  writeFileSync(join(bin, 'az'), AZ, { mode: 0o755 });
  store = mkdtempSync(join(tmpdir(), 'secrets-'));
  log = mkdtempSync(join(tmpdir(), 'az-log-'));
});

afterAll(() => {
  for (const dir of [bin, store, log]) rmSync(dir, { recursive: true, force: true });
});

const env = (more: Record<string, string>) => ({
  PATH: `${bin}:/usr/bin:/bin`,
  ABE_LOGINS_STORE: `file://${store}`,
  FAKE_AZ_LOG: log,
  ...more,
});

describe('on a box, where Entra refuses a device-code sign-in', () => {
  let abe: Cli;

  beforeAll(() => {
    abe = cli({ env: env({ ABE_LOGINS_SECRET: SECRET }) });
  });
  afterAll(async () => {
    await abe.close();
  });

  test('abe login az says what blocks it and what to do', async () => {
    const out = await abe.run('login', 'az');

    expect(out.exit).toBe(1);
    // az's own screen still reached the terminal: its code, then its refusal.
    expect(out.stderr).toContain('https://microsoft.com/devicelogin');
    expect(out.stderr).toContain(
      "abe: Microsoft Entra's security defaults refuse a device-code sign-in like a box's (AADSTS530035). Sign in on your own machine instead: abe login az there keeps the login for your boxes.",
    );
    expect(existsSync(secretPath(SECRET))).toBe(false);
  });

  test('abe login status names the refusal its check met', async () => {
    const { doc } = await abe.json(LoginStatusData, 'login', 'status');

    expect(doc.ok && doc.data.blocked).toEqual({ az: 'AADSTS53003' });
    const text = await abe.run('login', 'status');

    expect(text.stdout).toContain(
      "az     missing: Microsoft Entra's Conditional Access blocked this sign-in (AADSTS53003): a policy refuses this device or place. An Entra admin must allow it.",
    );
  });
});

describe('on the Mac: az signed in for the boxes', () => {
  let abe: Cli;

  beforeAll(() => {
    abe = cli({ env: env({ ABE_OWNER: 'octo' }) });
    // Another tool's login already stored: it stays.
    mkdirSync(dirname(secretPath(SECRET)), { recursive: true });
    writeFileSync(
      secretPath(SECRET),
      JSON.stringify({
        v: 1,
        logins: { github: { storedAt: '2026-10-23T02:30:00.000Z', files: { a: 'Yg==' } } },
      }),
    );
  });
  afterAll(async () => {
    await abe.close();
  });

  test('abe login az --tenant runs the browser login in a folder of its own and stores it', async () => {
    const out = await abe.run('login', 'az', '--tenant', 'contoso.onmicrosoft.com');

    expect(out.exit).toBe(0);
    expect(out.stdout).toBe(
      `your az login is stored in ${SECRET} (.azure/azureProfile.json, .azure/msal_token_cache.json, .azure/clouds.config)\n` +
        'your boxes restore it when they start; a running one now: abe --on <box> login restore\n',
    );
    expect(readFileSync(join(log, 'argv'), 'utf8').trim()).toBe(
      'login --allow-no-subscriptions --tenant contoso.onmicrosoft.com',
    );
    const dir = readFileSync(join(log, 'dir'), 'utf8').trim();

    // Never the person's own az folder; the folder it used is gone.
    expect(dir).not.toBe(join(abe.state.dir, '.azure'));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(abe.state.dir, '.azure'))).toBe(false);
    const doc = LoginDoc.parse(JSON.parse(readFileSync(secretPath(SECRET), 'utf8')));

    expect(doc.logins.github?.files).toEqual({ a: 'Yg==' });
    expect(Object.keys(doc.logins.az?.files ?? {})).toEqual([
      '.azure/azureProfile.json',
      '.azure/msal_token_cache.json',
      '.azure/clouds.config',
    ]);
    expect(out.stdout + out.stderr).not.toContain(FAKE_AZ_TOKEN);
  });

  test.each([
    {
      name: 'stored for your boxes',
      env: {},
      then: `your az login is stored in ${SECRET} (`,
    },
    {
      name: 'no boxes: the board sign-in alone, said',
      env: { ABE_OWNER: '', ABE_LOGINS_STORE: '' },
      then: 'not stored: this machine has no boxes (',
    },
  ])('in a checkout with its own az folder: signed in there, kept; $name', async (row) => {
    const top = mkdtempSync(join(tmpdir(), 'shop-'));
    const config = join(top, 'config');
    const checkout = join(top, 'shop');
    const folder = join(top, 'az-shop');

    try {
      mkdirSync(checkout);
      Bun.spawnSync(['git', 'init', '-q', checkout]);
      mkdirSync(config);
      // yours for the repo (ADR 0030)
      mkdirSync(join(checkout, '.abe'));
      writeFileSync(
        join(checkout, '.abe', 'settings.local.yaml'),
        `board:\n  azureConfigDir: ${folder}\n`,
      );
      const out = await abe.runWith(
        { env: { ABE_CONFIG_DIR: config, ...row.env }, cwd: checkout },
        'login',
        'az',
      );
      const [first, second] = out.stdout.split('\n');

      expect(out.exit).toBe(0);
      expect(first).toBe(`az signed in to ${folder} (this checkout's board.azureConfigDir)`);
      expect(second).toStartWith(row.then);
      expect(readFileSync(join(log, 'dir'), 'utf8').trim()).toBe(folder);
      expect(existsSync(join(folder, 'azureProfile.json'))).toBe(true);
      expect(out.stdout + out.stderr).not.toContain(FAKE_AZ_TOKEN);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test('--json prints one line, from the Mac', async () => {
    const { exit, doc } = await abe.json(LoginData, 'login', 'az');

    expect(exit).toBe(0);
    expect(doc.ok && doc.data).toMatchObject({ tool: 'az', secret: SECRET, from: 'mac' });
  });

  test('an Entra refusal on the Mac is named too', async () => {
    const out = await abe.runWith({ env: { FAKE_AZ_BLOCK: '1' } }, 'login', 'az');

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain(
      "abe: Microsoft Entra's Conditional Access blocked this sign-in (AADSTS53003)",
    );
  });

  test('boxes, their secret out of reach: refused before any sign-in', async () => {
    const config = join(log, 'aws-config');

    writeFileSync(config, '[profile abe-tooling]\nregion = eu-west-1\n');
    rmSync(join(log, 'argv'), { force: true });
    const out = await abe.runWith(
      {
        env: {
          ABE_OWNER: '',
          ABE_LOGINS_STORE: '',
          ABE_BOX_PROFILE: 'abe-tooling',
          AWS_CONFIG_FILE: config,
        },
      },
      'login',
      'az',
    );

    expect(out.exit).toBe(1);
    expect(existsSync(join(log, 'argv'))).toBe(false);
  });

  test('--tenant is for az only', async () => {
    const out = await abe.run('login', 'claude', '--tenant', 'x');

    expect(out.exit).toBe(2);
    expect(out.stderr).toContain('--tenant');
  });
});
