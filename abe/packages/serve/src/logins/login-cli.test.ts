/**
 * `abe login` through the CLI seam (#55): the real `abe` and a detached `serve` with fake `gh`,
 * `az` and `claude` on `PATH` and a folder standing in for Secrets Manager. A box starts with only
 * a GitHub seed, the person logs in to Claude Code and `az`, a refresh is written back, the box is
 * destroyed and made again and needs no login, and no value reaches `serve`'s log or its events.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventLine, LoginData, LoginDoc, LoginStatusData } from '@abe/core';
import {
  cli,
  type Cli,
  FAKE_AZ_TOKEN,
  FAKE_CLAUDE_TOKEN,
  FAKE_GITHUB_TOKEN,
  fakeLoginClis,
  type FakeLoginClis,
  until,
} from '@abe/testing';

const SECRET = 'abe/octo/logins';

let abe: Cli;
let clis: FakeLoginClis;
let store: string;

const secretPath = (name: string) => join(store, ...name.split('/'));

const stored = () =>
  existsSync(secretPath(SECRET))
    ? LoginDoc.parse(JSON.parse(readFileSync(secretPath(SECRET), 'utf8')))
    : undefined;

const home = () => abe.state.dir;

beforeAll(() => {
  clis = fakeLoginClis();
  store = mkdtempSync(join(tmpdir(), 'secrets-'));
  // Only GitHub's seed, as put in Secrets Manager before #55.
  mkdirSync(dirname(secretPath('abe/octo/github-token')), { recursive: true });
  writeFileSync(secretPath('abe/octo/github-token'), `${FAKE_GITHUB_TOKEN}\n`);
  abe = cli({
    env: {
      PATH: clis.path,
      ABE_LOGINS_SECRET: SECRET,
      ABE_LOGINS_STORE: `file://${store}`,
      ABE_LOGINS_EVERY_MS: '50',
    },
  });
});

afterAll(async () => {
  await abe.close();
  clis.remove();
  rmSync(store, { recursive: true, force: true });
});

describe('logins stored once', () => {
  test('a new box: GitHub from its seed, the others missing', async () => {
    const { exit, doc } = await abe.json(LoginStatusData, 'login', 'status');

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        secret: SECRET,
        logins: { github: 'ok', claude: 'missing', az: 'missing' },
        // asked outside a checkout: no checkout's az folder
        outside: true,
        // what az's check said, its first line
        said: { az: 'AADSTS70043: The refresh token has expired' },
      },
    });
    expect(stored()?.logins.github).toBeDefined();
  });

  test('abe login claude runs setup-token and stores its token', async () => {
    const out = await abe.run('login', 'claude');

    expect(out.exit).toBe(0);
    expect(out.stdout).toBe(
      `your claude login is stored in ${SECRET} (.claude/.credentials.json)\n`,
    );
    // The tool's own screen went to the terminal (stderr here): its URL to open on the Mac.
    expect(out.stderr).toContain('https://claude.ai/oauth/authorize');
    const creds = readFileSync(join(home(), '.claude/.credentials.json'), 'utf8');

    expect(creds).toContain(FAKE_CLAUDE_TOKEN);
    expect(stored()?.logins.claude).toBeDefined();
  });

  test('abe login az --json prints one line; the device code goes to stderr', async () => {
    const { exit, doc, stderr } = await abe.json(LoginData, 'login', 'az');

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        tool: 'az',
        secret: SECRET,
        files: ['.azure/azureProfile.json', '.azure/msal_token_cache.json'],
      },
    });
    expect(stderr).toContain('https://microsoft.com/devicelogin');
  });

  test('abe login github runs gh’s device login', async () => {
    const out = await abe.run('login', 'github');

    expect(out.exit).toBe(0);
    expect(out.stderr).toContain('FAKE-CODE');
  });

  test('a refreshed az token cache is written back', async () => {
    const refreshed = `{"AccessToken":{"x":{"secret":"${FAKE_AZ_TOKEN}-2"}}}`;

    writeFileSync(join(home(), '.azure/msal_token_cache.json'), refreshed);
    await until('the refresh in the secret', () => {
      const b = stored()?.logins.az?.files['.azure/msal_token_cache.json'];

      return b !== undefined && Buffer.from(b, 'base64').toString() === refreshed
        ? true
        : undefined;
    });
  });

  test('a destroyed and recreated box needs no login', async () => {
    expect((await abe.run('serve', 'stop')).exit).toBe(0);
    await until('serve gone', async () => {
      const s = await abe.run('status', '--no-start');

      return s.exit === 3 ? true : undefined;
    });
    for (const dir of ['.config', '.claude', '.azure'])
      rmSync(join(home(), dir), { recursive: true, force: true });
    const { doc } = await abe.json(LoginStatusData, 'login', 'status');

    expect(doc).toEqual({
      ok: true,
      data: {
        secret: SECRET,
        logins: { github: 'ok', claude: 'ok', az: 'ok' },
        who: { az: 'ada@example.com' },
        outside: true,
      },
    });
    expect(readFileSync(join(home(), '.config/gh/hosts.yml'), 'utf8')).toContain(FAKE_GITHUB_TOKEN);
  });

  test("no value reaches serve's log or its events", async () => {
    expect((await abe.run('login', 'az')).exit).toBe(0);
    const watch = abe.spawn('watch', '--since', '0', '--json');
    const lines: string[] = [];

    try {
      for (;;) lines.push(await watch.next(500));
    } catch {
      // No more held events.
    } finally {
      watch.signal('SIGKILL');
    }
    const types = lines.map((l) => EventLine.parse(JSON.parse(l)).type);

    expect(types).toContain('login.restored');
    expect(types).toContain('login.stored');
    const log = readFileSync(join(abe.state.dir, 'serve.log'), 'utf8');

    for (const value of [FAKE_GITHUB_TOKEN, FAKE_CLAUDE_TOKEN, FAKE_AZ_TOKEN]) {
      expect(lines.join('\n')).not.toContain(value);
      expect(log).not.toContain(value);
    }
  });
});

describe("on a Mac with no boxes: each tool's own login, never aws or a logins secret", () => {
  let mac: Cli;
  let macClis: FakeLoginClis;

  beforeAll(() => {
    macClis = fakeLoginClis();
    mac = cli({ env: { PATH: macClis.path } });
  });
  afterAll(async () => {
    await mac.close();
    macClis.remove();
  });

  test.each<{
    name: string;
    tool: string;
    env: Record<string, string>;
    said: string[];
    ran: string;
  }>([
    {
      name: 'az, no box.profile: signed in to az’s own folder',
      tool: 'az',
      env: {},
      said: [
        'az signed in on this machine',
        "not stored: this machine has no boxes (no box.profile names your boxes' aws profile)",
      ],
      ran: 'az login --allow-no-subscriptions',
    },
    {
      name: 'az, a box.profile not in the aws config: no boxes either',
      tool: 'az',
      env: { ABE_BOX_PROFILE: 'abe-tooling' },
      said: [
        'az signed in on this machine',
        'not stored: this machine has no boxes (box.profile abe-tooling is not in your aws config)',
      ],
      ran: 'az login --allow-no-subscriptions',
    },
    {
      name: 'github: gh’s own browser login',
      tool: 'github',
      env: {},
      said: [
        'github signed in on this machine',
        "not stored: this machine has no boxes (no box.profile names your boxes' aws profile)",
      ],
      ran: 'gh auth login --hostname github.com --git-protocol https --web',
    },
    {
      name: 'claude: Claude Code’s own login',
      tool: 'claude',
      env: {},
      said: [
        'claude signed in on this machine',
        "not stored: this machine has no boxes (no box.profile names your boxes' aws profile)",
      ],
      ran: 'claude auth login',
    },
  ])('$name', async (row) => {
    const before = macClis.calls().length;
    const out = await mac.runWith({ env: row.env }, 'login', row.tool);
    const ran = macClis.calls().slice(before);

    expect([out.exit, out.stdout.split('\n').filter((l) => l !== '')]).toEqual([0, row.said]);
    expect(
      ran.filter(
        (c) =>
          !c.includes(' status') &&
          !c.includes('get-access-token') &&
          !c.includes('account show') &&
          !c.includes('--version'),
      ),
    ).toEqual([row.ran]);
    expect(ran.some((c) => c.startsWith('aws '))).toBe(false);
  });
});
