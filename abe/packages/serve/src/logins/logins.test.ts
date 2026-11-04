/**
 * Logins stored once (#55) in a real `serve` with a fake Secrets Manager and fake tools: restore
 * on start (stored logins, seeds, a newer local login kept), writing back a refreshed login,
 * `abe login <tool>`'s store, `abe login status`, and another owner's secret refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  claudeCredentials,
  emptyLoginDoc,
  journal,
  envelope,
  LoginData,
  LoginDoc,
  LoginRestoreData,
  LoginStatusData,
  type LoginTool,
  type Reply,
  withLogin,
} from '@abe/core';
import {
  FAKE_CLAUDE_TOKEN,
  FAKE_GITHUB_TOKEN,
  fakeClock,
  fakeLoginStore,
  type FakeLoginStore,
  fakeLoginTools,
  type FakeLoginTools,
  scenario,
  type ServeScenario,
  until,
} from '@abe/testing';
import { startStoredLogins } from './logins';

const SECRET = 'abe/octo/logins';
const STORED_AT = '2026-10-22T08:00:00.000Z';
const b64 = (text: string) => Buffer.from(text).toString('base64');

const HOSTS = `github.com:\n    oauth_token: ${FAKE_GITHUB_TOKEN}\n    user: octocat\n`;
const PROFILE = '{"subscriptions":[{"id":"sub"}]}';
const CACHE = '{"RefreshToken":{"k":{"secret":"az-refresh-1"}}}';

const storedDoc = () =>
  withLogin(
    withLogin(emptyLoginDoc(), 'github', { '.config/gh/hosts.yml': b64(HOSTS) }, STORED_AT),
    'az',
    {
      '.azure/azureProfile.json': b64(PROFILE),
      '.azure/msal_token_cache.json': b64(CACHE),
    },
    STORED_AT,
  );

type World = {
  s: ServeScenario;
  home: string;
  store: FakeLoginStore;
  tools: FakeLoginTools;
};

const worlds: World[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.s.close();
    rmSync(w.home, { recursive: true, force: true });
  }
});

const world = async (o: {
  secrets?: Record<string, { text: string; createdAt?: string }>;
  secret?: string | null;
  before?: (home: string) => void;
  /** Secrets refused from the start. */
  deny?: string[];
  env?: Record<string, string>;
}): Promise<World> => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));

  o.before?.(home);
  const store = fakeLoginStore(o.secrets ?? {});

  for (const d of o.deny ?? []) store.denied.add(d);
  const tools = fakeLoginTools(home);
  const s = await scenario({
    ...(o.env === undefined ? {} : { env: o.env }),
    storedLogins: {
      secret: o.secret === undefined ? SECRET : o.secret,
      store,
      tools,
      home,
      every: 25,
    },
  });
  const w = { s, home, store, tools };

  worlds.push(w);

  return w;
};

const put = (home: string, rel: string, text: string) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};

const read = (home: string, rel: string) => readFileSync(join(home, rel), 'utf8');

const docOf = (store: FakeLoginStore, secret = SECRET) =>
  LoginDoc.parse(JSON.parse(store.secrets.get(secret)?.text ?? 'null'));

const storedText = (store: FakeLoginStore, tool: LoginTool, rel: string) => {
  const b = docOf(store).logins[tool]?.files[rel];

  return b === undefined ? undefined : Buffer.from(b, 'base64').toString('utf8');
};

const json = <T extends Parameters<typeof envelope>[0]>(schema: T, reply: Reply) =>
  envelope(schema).parse(JSON.parse(reply.stdout));

describe('on start, a box restores the stored logins', () => {
  test('each where its tool reads it, readable by the person only', async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });

    await until('the az login restored', () =>
      w.store.calls.length > 0 && statSafe(join(w.home, '.azure/msal_token_cache.json'))
        ? true
        : undefined,
    );
    expect(read(w.home, '.config/gh/hosts.yml')).toBe(HOSTS);
    expect(read(w.home, '.azure/azureProfile.json')).toBe(PROFILE);
    expect(statSync(join(w.home, '.config/gh/hosts.yml')).mode & 0o777).toBe(0o600);
    expect(statSync(join(w.home, '.config/gh')).mode & 0o777).toBe(0o700);
  });

  test('a tool with nothing stored comes from its seed, then is stored', async () => {
    const w = await world({
      secrets: {
        'abe/octo/github-token': { text: `${FAKE_GITHUB_TOKEN}\n` },
        'abe/octo/claude-token': {
          text: FAKE_CLAUDE_TOKEN,
          createdAt: '2026-10-23T02:30:00.000Z',
        },
      },
    });

    await until('both seeds stored', () =>
      w.store.secrets.has(SECRET) &&
      docOf(w.store).logins.claude !== undefined &&
      docOf(w.store).logins.github !== undefined
        ? true
        : undefined,
    );
    expect(w.tools.githubTokens).toEqual([FAKE_GITHUB_TOKEN]);
    const creds: unknown = JSON.parse(read(w.home, '.claude/.credentials.json'));

    expect(creds).toMatchObject({
      claudeAiOauth: {
        accessToken: FAKE_CLAUDE_TOKEN,
        refreshToken: null,
        expiresAt: Date.parse('2027-10-23T02:30:00.000Z'),
      },
    });
    expect(storedText(w.store, 'github', '.config/gh/hosts.yml')).toContain(FAKE_GITHUB_TOKEN);
    expect(docOf(w.store).logins.az).toBeUndefined();
  });

  test('a login newer here than the stored one is kept and stored', async () => {
    const newer = 'github.com:\n    oauth_token: ghp_newer\n';
    const w = await world({
      secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } },
      before: (home) => {
        put(home, '.config/gh/hosts.yml', newer);
      },
    });

    await until('the newer github login stored', () =>
      storedText(w.store, 'github', '.config/gh/hosts.yml') === newer ? true : undefined,
    );
    expect(read(w.home, '.config/gh/hosts.yml')).toBe(newer);
    expect(read(w.home, '.azure/azureProfile.json')).toBe(PROFILE);
  });

  test('abe login restore says what went where', async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });
    const doc = json(LoginRestoreData, await w.s.request('login', 'restore', '--json'));

    expect(doc).toEqual({
      ok: true,
      data: {
        secret: SECRET,
        restored: ['github', 'az'],
        seeded: [],
        kept: [],
        missing: ['claude', 'aws'],
      },
    });
  });

  test('a secret holding something else is never overwritten', async () => {
    const w = await world({ secrets: { [SECRET]: { text: 'not a login document' } } });
    const reply = await w.s.request('login', 'restore', '--json');

    expect(reply.exit).toBe(1);
    expect(JSON.parse(reply.stdout)).toMatchObject({
      ok: false,
      error: { code: 'bad-login-secret' },
    });
    expect(w.store.calls.filter((c) => c.op === 'write')).toEqual([]);
  });
});

const statSafe = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

describe('a refreshed login is written back', () => {
  test('within the look, replacing only its own tool', async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });

    await until('restored', () =>
      statSafe(join(w.home, '.azure/msal_token_cache.json')) ? true : undefined,
    );
    // Another box of the person's stored a newer GitHub login meanwhile.
    const other = withLogin(
      docOf(w.store),
      'github',
      { '.config/gh/hosts.yml': b64('other box') },
      STORED_AT,
    );

    w.store.secrets.set(SECRET, { text: JSON.stringify(other), createdAt: STORED_AT });
    // az refreshes its token cache.
    const refreshed = '{"RefreshToken":{"k":{"secret":"az-refresh-2"}}}';

    put(w.home, '.azure/msal_token_cache.json', refreshed);
    await until('the refreshed cache written back', () =>
      storedText(w.store, 'az', '.azure/msal_token_cache.json') === refreshed ? true : undefined,
    );
    expect(storedText(w.store, 'github', '.config/gh/hosts.yml')).toBe('other box');
  });

  test("az's own empty profile, with no token cache, is no login to write back", async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });

    await until('restored', () =>
      statSafe(join(w.home, '.azure/msal_token_cache.json')) ? true : undefined,
    );
    rmSync(join(w.home, '.azure'), { recursive: true });
    put(w.home, '.azure/azureProfile.json', '{"subscriptions":[]}');
    await Bun.sleep(150);
    expect(storedText(w.store, 'az', '.azure/msal_token_cache.json')).toBe(CACHE);
    expect(w.store.calls.filter((c) => c.op === 'write')).toEqual([]);
  });

  test('with the secret unreachable at start, nothing is written back until a restore works', async () => {
    const w = await world({
      secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } },
      before: (home) => {
        put(home, '.config/gh/hosts.yml', 'an old login left on the disk');
      },
      deny: [SECRET],
    });

    await Bun.sleep(150);
    expect(w.store.calls.filter((c) => c.op === 'write')).toEqual([]);
    w.store.denied.delete(SECRET);
    await until('restored at a later look', () =>
      statSafe(join(w.home, '.azure/msal_token_cache.json')) ? true : undefined,
    );
  });

  test("a newer login another box stored comes here, never overwritten by this box's older one", async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });

    await until('restored', () =>
      statSafe(join(w.home, '.azure/msal_token_cache.json')) ? true : undefined,
    );
    const newer = withLogin(
      docOf(w.store),
      'github',
      { '.config/gh/hosts.yml': b64('from the other box') },
      new Date(Date.now() + 60_000).toISOString(),
    );

    w.store.secrets.set(SECRET, { text: JSON.stringify(newer), createdAt: STORED_AT });
    await until('the other box’s login here', () =>
      read(w.home, '.config/gh/hosts.yml') === 'from the other box' ? true : undefined,
    );
    expect(storedText(w.store, 'github', '.config/gh/hosts.yml')).toBe('from the other box');
  });

  test('nothing is written while nothing changes', async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });

    await until('restored', () =>
      statSafe(join(w.home, '.azure/msal_token_cache.json')) ? true : undefined,
    );
    await Bun.sleep(150);
    expect(w.store.calls.filter((c) => c.op === 'write')).toEqual([]);
  });
});

describe('abe login <tool> stores what the tool wrote', () => {
  test('the login, beside the others', async () => {
    const w = await world({ secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } } });

    put(w.home, '.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x"}}');
    const doc = json(LoginData, await w.s.request('login', 'claude', '--json'));

    expect(doc).toEqual({
      ok: true,
      data: { tool: 'claude', secret: SECRET, files: ['.claude/.credentials.json'] },
    });
    expect(storedText(w.store, 'claude', '.claude/.credentials.json')).toContain('sk-ant-oat01-x');
    expect(docOf(w.store).logins.az).toBeDefined();
  });

  test('refused when the tool wrote nothing', async () => {
    const w = await world({});
    const reply = await w.s.request('login', 'az', '--json');

    expect(reply.exit).toBe(1);
    expect(JSON.parse(reply.stdout)).toMatchObject({ ok: false, error: { code: 'no-login' } });
  });

  test('refused where no secret is named, and nothing restored over this machine', async () => {
    const w = await world({
      secret: null,
      secrets: { [SECRET]: { text: JSON.stringify(storedDoc()) } },
      before: (home) => {
        put(home, '.claude/.credentials.json', '{}');
      },
    });
    const reply = await w.s.request('login', 'claude', '--json');

    expect(JSON.parse(reply.stdout)).toMatchObject({
      ok: false,
      error: { code: 'no-logins-secret' },
    });
    expect(w.store.calls).toEqual([]);
    expect(statSafe(join(w.home, '.config/gh/hosts.yml'))).toBeUndefined();
  });

  test("another owner's secret is refused, saying so", async () => {
    const w = await world({ secret: 'abe/someone-else/logins' });

    w.store.denied.add('abe/someone-else/logins');
    put(w.home, '.config/gh/hosts.yml', HOSTS);
    const reply = await w.s.request('login', 'github', '--json');

    expect(reply.exit).toBe(1);
    expect(JSON.parse(reply.stdout)).toMatchObject({
      ok: false,
      error: { code: 'secret-unreadable' },
    });
    expect(reply.stdout).toContain('AccessDenied');
    expect(reply.stdout).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

describe("a box session's tokens come from the restored logins", () => {
  test('once restored; missing ones named', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const store = fakeLoginStore({
      'abe/octo/github-token': { text: FAKE_GITHUB_TOKEN },
    });
    const logins = startStoredLogins({
      secret: SECRET,
      store,
      tools: fakeLoginTools(home),
      home,
      every: 3_600_000,
      clock: fakeClock(),
      emit: journal(fakeClock()).emit,
    });

    try {
      expect(await logins.boxLogins?.read()).toEqual({
        ok: false,
        error: { code: 'no-login', message: 'no claude login on this box: abe login claude' },
      });
      put(home, '.claude/.credentials.json', claudeCredentials(FAKE_CLAUDE_TOKEN, 1));
      expect(await logins.boxLogins?.read()).toEqual({
        ok: true,
        data: { claude: FAKE_CLAUDE_TOKEN, github: FAKE_GITHUB_TOKEN },
      });
    } finally {
      await logins.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('abe login status', () => {
  test('each tool ok, expired or missing', async () => {
    const w = await world({
      secret: null,
      before: (home) => {
        put(home, '.config/gh/hosts.yml', HOSTS);
        put(home, '.azure/azureProfile.json', PROFILE);
        put(home, '.azure/msal_token_cache.json', CACHE);
        put(
          home,
          '.claude/.credentials.json',
          JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: null, expiresAt: 1 } }),
        );
      },
    });

    w.tools.set('github', true);
    w.tools.set('claude', true);
    expect(json(LoginStatusData, await w.s.request('login', 'status', '--json'))).toEqual({
      ok: true,
      data: {
        secret: null,
        logins: { github: 'ok', claude: 'expired', az: 'expired' },
        outside: true,
      },
    });
    rmSync(join(w.home, '.azure'), { recursive: true });
    rmSync(join(w.home, '.claude'), { recursive: true });
    w.tools.set('claude', false);
    expect(json(LoginStatusData, await w.s.request('login', 'status', '--json'))).toEqual({
      ok: true,
      data: {
        secret: null,
        logins: { github: 'ok', claude: 'missing', az: 'missing' },
        outside: true,
      },
    });
  });

  test('#345: a working login says who it is signed in as; one not working names no one', async () => {
    const w = await world({
      secret: null,
      before: (home) => {
        put(home, '.config/gh/hosts.yml', HOSTS);
        put(home, '.azure/azureProfile.json', PROFILE);
        put(home, '.azure/msal_token_cache.json', CACHE);
      },
    });

    w.tools.set('github', true, 'octocat');
    w.tools.set('az', false, 'octo@example.com');
    expect(json(LoginStatusData, await w.s.request('login', 'status', '--json'))).toEqual({
      ok: true,
      data: {
        secret: null,
        logins: { github: 'ok', claude: 'missing', az: 'expired' },
        who: { github: 'octocat' },
        outside: true,
      },
    });
  });

  test("#160: a tool not on serve's PATH is unchecked with why, not expired", async () => {
    const w = await world({
      secret: null,
      before: (home) => {
        put(home, '.config/gh/hosts.yml', HOSTS);
      },
    });

    w.tools.cannot('github', "gh not found on serve's PATH");
    expect(json(LoginStatusData, await w.s.request('login', 'status', '--json'))).toEqual({
      ok: true,
      data: {
        secret: null,
        logins: { github: 'unchecked', claude: 'missing', az: 'missing' },
        unchecked: { github: "gh not found on serve's PATH" },
        outside: true,
      },
    });
    const text = (await w.s.request('login', 'status')).stdout;

    expect(text).toContain("github can't check: gh not found on serve's PATH  (abe tools check)");
    // The Mac keeps no logins: each tool's own login, not `abe login`, which refuses there.
    expect(text).toContain('claude missing  (claude auth login)');
  });

  const SAID = "ERROR: Please run 'az login' to setup account.";

  test.each<[string, string | undefined, boolean, string[], string]>([
    [
      "az's own folder, in a checkout",
      undefined,
      true,
      [],
      `az     missing: this checkout reads az's own folder (~/.azure); az said: ${SAID}  (az login --allow-no-subscriptions)`,
    ],
    [
      "az's own folder, outside a checkout",
      undefined,
      false,
      [],
      `az     missing: az's own folder (~/.azure); az said: ${SAID}  (az login --allow-no-subscriptions)`,
    ],
    [
      'your folder under /tmp, in a checkout',
      '/tmp/abe-az',
      true,
      ['/tmp/abe-az'],
      `az     missing: this checkout reads az from /tmp/abe-az (board.azureConfigDir here); /tmp/abe-az is wiped on restart: use a folder under ~/.config (abe settings set board.azureConfigDir ~/.config/az --mine); az said: ${SAID}  (AZURE_CONFIG_DIR=/tmp/abe-az az login --allow-no-subscriptions)`,
    ],
  ])(
    'az is checked in the folder in force, its row naming it: %s',
    async (_, dir, inCheckout, checked, row) => {
      const config = mkdtempSync(join(tmpdir(), 'mine-'));
      const checkout = mkdtempSync(join(tmpdir(), 'shop-'));

      Bun.spawnSync(['git', 'init', '-q', checkout]);
      // yours for the repo (ADR 0030)
      if (dir !== undefined)
        put(checkout, '.abe/settings.local.yaml', `board:\n  azureConfigDir: ${dir}\n`);
      try {
        const w = await world({ secret: null, env: { ABE_CONFIG_DIR: config } });
        const ask = (...argv: string[]) =>
          inCheckout ? w.s.requestIn(checkout, ...argv) : w.s.request(...argv);

        w.tools.fails('az', SAID);
        const data = json(LoginStatusData, await ask('login', 'status', '--json'));

        expect(data).toMatchObject({
          ok: true,
          data: { logins: { az: 'missing' }, said: { az: SAID } },
        });
        expect(data.ok && data.data.azureConfigDir).toEqual(
          dir === undefined ? undefined : { from: 'checkout', dir },
        );
        expect(data.ok && data.data.outside).toBe(inCheckout ? undefined : true);
        expect(w.tools.azureConfigDirs).toEqual(checked);
        expect((await ask('login', 'status')).stdout.split('\n')).toContain(row);
      } finally {
        rmSync(config, { recursive: true, force: true });
        rmSync(checkout, { recursive: true, force: true });
      }
    },
  );

  test('its text names the command for each that is not ok', async () => {
    const w = await world({});
    const reply = await w.s.request('login', 'status');

    expect(reply.stdout).toContain('github missing  (abe login github)');
    expect(reply.stdout).toContain(`kept in ${SECRET}`);
  });
});
