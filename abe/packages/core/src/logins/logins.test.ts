import { describe, expect, test } from 'bun:test';
import {
  addLogins,
  awsCacheKey,
  awsConfigFor,
  awsProfileKind,
  awsSignIn,
  awsWho,
  type AzLoginFolder,
  LoginEntryValue,
  LOGINS,
  loginNeeds,
  mergeAwsConfig,
  repoLogins,
  repoLoginsReason,
  claudeCredentials,
  claudeProbe,
  claudeTokenOf,
  githubTokenOf,
  emptyLoginDoc,
  entraBlock,
  LOGIN_ARGV,
  LOGIN_FILES,
  loginArgv,
  macAzLoginArgv,
  loginDocText,
  loginState,
  loginStatusText,
  readLoginDoc,
  regionOfSecret,
  restorable,
  restorePlan,
  seedSecret,
  seedToken,
  syncWay,
  setupTokenOf,
  withLogin,
} from './logins';

const AT = '2026-10-23T06:00:00.000Z';
const AT_MS = Date.parse(AT);

describe('the login document', () => {
  test('no secret value yet reads as no logins', () => {
    expect(readLoginDoc(null)).toEqual({ ok: true, doc: emptyLoginDoc() });
  });

  test('a document of another shape is refused, not overwritten', () => {
    expect(readLoginDoc('{"v":2}').ok).toBe(false);
    expect(readLoginDoc('not json').ok).toBe(false);
  });

  test('a login replaces only its own tool', () => {
    const one = withLogin(emptyLoginDoc(), 'github', { '.config/gh/hosts.yml': 'aG9zdHM=' }, AT);
    const two = withLogin(one, 'az', { '.azure/azureProfile.json': 'e30=' }, AT);
    const again = withLogin(two, 'github', { '.config/gh/hosts.yml': 'bmV3' }, AT);

    expect(again.logins.az?.files).toEqual({ '.azure/azureProfile.json': 'e30=' });
    expect(again.logins.github?.files).toEqual({ '.config/gh/hosts.yml': 'bmV3' });
  });

  test('round trips through its text', () => {
    const doc = withLogin(emptyLoginDoc(), 'claude', { '.claude/.credentials.json': 'e30=' }, AT);
    const text = loginDocText(doc);

    expect(text.ok).toBe(true);
    expect(text.ok && readLoginDoc(text.text)).toEqual({ ok: true, doc });
  });

  test('more than a secret holds is refused', () => {
    const big = withLogin(emptyLoginDoc(), 'az', { '.azure/x': 'A'.repeat(70_000) }, AT);

    const text = loginDocText(big);

    expect(text.ok).toBe(false);
    expect(!text.ok && text.message).toContain('65536');
  });
});

describe('restore on start', () => {
  const stored = withLogin(
    withLogin(emptyLoginDoc(), 'github', { '.config/gh/hosts.yml': 'aA==' }, AT),
    'az',
    { '.azure/azureProfile.json': 'e30=' },
    AT,
  );

  test('a fresh box gets every stored login and the seeds of the others', () => {
    expect(restorePlan(stored, { github: null, claude: null, az: null })).toEqual({
      write: ['github', 'az'],
      keep: [],
      seed: ['claude'],
    });
  });

  test('a local login newer than the stored one is kept (and written back)', () => {
    expect(restorePlan(stored, { github: AT_MS + 1, claude: null, az: AT_MS - 1 })).toEqual({
      write: ['az'],
      keep: ['github'],
      seed: ['claude'],
    });
  });

  test('a local login with nothing stored is kept, never seeded over', () => {
    expect(restorePlan(emptyLoginDoc(), { github: AT_MS, claude: AT_MS, az: null })).toEqual({
      write: [],
      keep: ['github', 'claude'],
      seed: [],
    });
  });

  test('az has no seed', () => {
    expect(restorePlan(emptyLoginDoc(), { github: null, claude: null, az: null }).seed).toEqual([
      'github',
      'claude',
    ]);
  });
});

describe('syncing a login', () => {
  const stored = { storedAt: AT, files: {} };

  test.each([
    ['nothing stored', undefined, AT_MS, false, 'store'],
    ['the same files', stored, AT_MS + 9, true, 'same'],
    ['newer here', stored, AT_MS + 1, false, 'store'],
    ['newer stored (another box refreshed it)', stored, AT_MS, false, 'pull'],
  ] as const)('%s', (_, s, localMtimeMs, same, way) => {
    expect(syncWay({ stored: s, localMtimeMs, same })).toBe(way);
  });

  test('a stored document names only its tool’s own files', () => {
    expect(
      restorable('github', {
        '.config/gh/hosts.yml': 'aA==',
        '.ssh/authorized_keys': 'aA==',
        '../x': 'aA==',
      }),
    ).toEqual({ '.config/gh/hosts.yml': 'aA==' });
  });

  test.each([
    ['.aws/config', true],
    ['.aws/sso/cache/0a1b2c.json', true],
    ['.aws/sso/cache/sub/x.json', false],
    ['.aws/sso/cache/../../.ssh/id.json', false],
    ['.aws/sso/cache/notes.txt', false],
    ['.aws/credentials', false],
  ])('aws: %s is %s', (rel, kept) => {
    expect(Object.keys(restorable('aws', { [rel]: 'aA==' }))).toEqual(kept ? [rel] : []);
  });
});

describe('seeds', () => {
  test('a seed is the token itself or {"token": …}', () => {
    expect(seedToken('ghp_x\n')).toBe('ghp_x');
    expect(seedToken('{"token":"ghp_y"}')).toBe('ghp_y');
  });

  test("are the person's secret's siblings", () => {
    expect(seedSecret('abe/ada/logins', 'github')).toBe('abe/ada/github-token');
    expect(seedSecret('abe/ada/logins', 'claude')).toBe('abe/ada/claude-token');
    expect(
      seedSecret(
        'arn:aws:secretsmanager:eu-west-1:111111111111:secret:abe/ada/logins-AbCdEf',
        'github',
      ),
    ).toBe('arn:aws:secretsmanager:eu-west-1:111111111111:secret:abe/ada/github-token');
    expect(seedSecret('abe/ada/logins', 'az')).toBeUndefined();
  });

  test('an ARN names its region; a name leaves it to aws', () => {
    expect(regionOfSecret('arn:aws:secretsmanager:eu-west-1:111111111111:secret:abe/x')).toBe(
      'eu-west-1',
    );
    expect(regionOfSecret('abe/ada/logins')).toBeNull();
  });
});

describe('Claude Code', () => {
  const TOKEN = `sk-ant-oat01-${'a1B2_c3-'.repeat(12)}AA`;

  test("setup-token's output gives its token, colours and line ends aside", () => {
    const out = `\u001b[2J\u001b[32m✓ Long-lived authentication token created successfully!\u001b[39m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\u001b[1m${TOKEN}\u001b[22m\r\n\r\nStore this token securely.\r\n`;

    expect(setupTokenOf(out)).toBe(TOKEN);
    expect(setupTokenOf('Opening browser…\r\nCancelled\r\n')).toBeUndefined();
  });

  test('a token becomes the credentials file Claude Code reads', () => {
    const file: unknown = JSON.parse(claudeCredentials(TOKEN, AT_MS));

    expect(file).toEqual({
      claudeAiOauth: {
        accessToken: TOKEN,
        refreshToken: null,
        expiresAt: AT_MS,
        scopes: ['user:inference'],
        subscriptionType: null,
      },
    });
  });

  test('its file says when it ends and whether it renews itself', () => {
    expect(claudeProbe(claudeCredentials(TOKEN, AT_MS))).toEqual({
      expiresAt: AT_MS,
      refreshes: false,
    });
    expect(
      claudeProbe(
        JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'r', expiresAt: 5 } }),
      ),
    ).toEqual({ expiresAt: 5, refreshes: true });
    expect(claudeProbe('{}')).toBeUndefined();
    expect(claudeProbe('garbage')).toBeUndefined();
  });
});

describe("a box session's tokens", () => {
  test("github.com's token from gh's hosts.yml, not another host's", () => {
    const hosts = [
      'ghe.example.com:',
      '    oauth_token: other',
      'github.com:',
      '    users:',
      '        octocat:',
      '            oauth_token: ghp_inner',
      '    git_protocol: https',
      '    oauth_token: ghp_main',
      '    user: octocat',
      '',
    ].join('\n');

    expect(['ghp_inner', 'ghp_main']).toContain(githubTokenOf(hosts) ?? '');
    expect(githubTokenOf('ghe.example.com:\n    oauth_token: other\n')).toBeUndefined();
  });

  test("Claude Code's access token from its credentials file", () => {
    expect(claudeTokenOf(claudeCredentials('sk-ant-oat01-x', 1))).toBe('sk-ant-oat01-x');
    expect(claudeTokenOf('{}')).toBeUndefined();
  });
});

describe('a login’s state', () => {
  test.each([
    ['github', { present: true, check: { works: true } }, 'ok'],
    ['github', { present: true, check: { works: false } }, 'expired'],
    ['github', { present: false, check: { works: false } }, 'missing'],
    ['az', { present: true, check: { works: false } }, 'expired'],
    ['az', { present: false, check: { works: true } }, 'ok'],
    // #160: the tool not on serve's PATH is no expired login, only one not checked.
    ['github', { present: true, check: { cannot: "gh not found on serve's PATH" } }, 'unchecked'],
    ['az', { present: false, check: { cannot: "az not found on serve's PATH" } }, 'unchecked'],
  ] as const)('%s %j is %s', (tool, probe, state) => {
    expect(loginState(tool, { ...probe, claude: undefined, now: AT_MS })).toBe(state);
  });

  test.each([
    ['a token not yet ended', { expiresAt: AT_MS + 1, refreshes: false }, 'ok'],
    ['a token that ended', { expiresAt: AT_MS, refreshes: false }, 'expired'],
    ['an ended token that renews itself', { expiresAt: AT_MS - 1, refreshes: true }, 'ok'],
  ] as const)('claude with %s', (_, claude, state) => {
    expect(
      loginState('claude', { present: true, check: { works: true }, claude, now: AT_MS }),
    ).toBe(state);
  });

  test('claude with no file is ok only when Claude Code says it is logged in', () => {
    const probe = { present: false, claude: undefined, now: AT_MS };

    expect(loginState('claude', { ...probe, check: { works: true } })).toBe('ok');
    expect(loginState('claude', { ...probe, check: { works: false } })).toBe('missing');
    // #190: its check failing on something else (the selected model) claims no missing login.
    expect(loginState('claude', { ...probe, check: { cannot: 'claude auth status: x' } })).toBe(
      'unchecked',
    );
  });
});

describe('the logins: setting', () => {
  test.each([
    ['gh', { tool: 'github', name: 'gh', profile: null, tenant: null }],
    ['github', { tool: 'github', name: 'github', profile: null, tenant: null }],
    ['claude', { tool: 'claude', name: 'claude', profile: null, tenant: null }],
    [
      { aws: { profile: 'shop-test', sso: true } },
      { tool: 'aws', name: 'aws', profile: 'shop-test', tenant: null },
    ],
    [
      { az: { tenant: 'contoso.onmicrosoft.com' } },
      { tool: 'az', name: 'az', profile: null, tenant: 'contoso.onmicrosoft.com' },
    ],
  ] as const)('%j reads as a need', (entry, need) => {
    expect(loginNeeds([LoginEntryValue.parse(entry)])).toEqual([need]);
  });

  test.each([
    ['an unknown tool', 'docker'],
    ['two tools in one entry', { aws: {}, gh: {} }],
    ['a profile on gh', { gh: { profile: 'x' } }],
    ['a tenant on aws', { aws: { tenant: 't' } }],
    ['an unknown option', { aws: { role: 'admin' } }],
    ['a profile with spaces', { aws: { profile: 'my profile' } }],
  ])('refused: %s', (_, entry) => {
    expect(LoginEntryValue.safeParse(entry).success).toBe(false);
  });

  test.each<[string, LoginEntryValue[], LoginEntryValue[], LoginEntryValue[]]>([
    ['a lower Layer adds a tool', ['gh'], ['claude'], ['gh', 'claude']],
    ['the same tool by another name is the same tool', ['github'], ['gh'], ['gh']],
    [
      "a lower Layer's options replace the tool's above",
      ['gh', { aws: { profile: 'a' } }],
      [{ aws: { profile: 'b' } }],
      ['gh', { aws: { profile: 'b' } }],
    ],
  ])('%s', (_, above, written, merged) => {
    expect(addLogins(above, written)).toEqual(merged);
  });
});

describe("a repo's logins against these", () => {
  const needs = loginNeeds(['gh', { aws: { profile: 'shop-test', sso: true } }, 'claude']);
  const status = (
    logins: {
      github: 'ok' | 'missing' | 'expired';
      claude: 'ok' | 'missing' | 'expired';
      az: 'ok';
      aws?: 'ok' | 'missing' | 'expired';
    },
    secret: string | null = null,
  ) => repoLogins('shop', needs, { secret, logins, who: { github: 'octocat' } });

  test.each([
    ['all present', { github: 'ok', claude: 'ok', az: 'ok', aws: 'ok' }, [], [], true],
    ['aws missing', { github: 'ok', claude: 'ok', az: 'ok', aws: 'missing' }, ['aws'], [], false],
    ['gh expired', { github: 'expired', claude: 'ok', az: 'ok', aws: 'ok' }, ['github'], [], false],
    // aws checked for no profile: it can't be said
    ['aws not checked', { github: 'ok', claude: 'ok', az: 'ok' }, [], ['aws'], false],
  ] as const)('%s', (_, logins, missing, unchecked, ready) => {
    const r = status(logins);

    expect({ missing: r.missing, unchecked: r.unchecked, ready: r.ready }).toEqual({
      missing: [...missing],
      unchecked: [...unchecked],
      ready,
    });
  });

  test('each row: its state, who while ok, its sign-in while not', () => {
    expect(
      status({ github: 'ok', claude: 'expired', az: 'ok', aws: 'missing' }, 'abe/o/logins').needs,
    ).toEqual([
      { tool: 'github', name: 'gh', profile: null, state: 'ok', who: 'octocat', fix: null },
      {
        tool: 'aws',
        name: 'aws',
        profile: 'shop-test',
        state: 'missing',
        who: null,
        fix: 'abe login aws --profile shop-test',
      },
      {
        tool: 'claude',
        name: 'claude',
        profile: null,
        state: 'expired',
        who: null,
        fix: 'abe login claude',
      },
    ]);
  });

  test.each<[string, AzLoginFolder | undefined, string | undefined, string]>([
    [
      "az's own folder",
      undefined,
      'ada@example.com',
      "signed in as ada@example.com; this checkout reads az's own folder (~/.azure)",
    ],
    [
      "this checkout's folder",
      { from: 'checkout', dir: '/me/az-acme' },
      'ada@acme.example',
      'signed in as ada@acme.example; this checkout reads az from /me/az-acme (board.azureConfigDir here)',
    ],
    ['who not said', undefined, undefined, "this checkout reads az's own folder (~/.azure)"],
  ])('az ok: its row says who and the folder checked, %s', (_, folder, who, note) => {
    const r = repoLogins('shop', loginNeeds(['az']), {
      secret: null,
      logins: { github: 'ok', claude: 'ok', az: 'ok' },
      ...(who === undefined ? {} : { who: { az: who } }),
      ...(folder === undefined ? {} : { azureConfigDir: folder }),
    });

    expect(r.needs[0]).toMatchObject({ state: 'ok', note });
    expect(
      loginStatusText({ secret: null, logins: { github: 'ok', claude: 'ok', az: 'ok' }, repo: r }),
    ).toContain(`  az  ok: ${note}\n`);
  });

  test('a repo with no logins: needs none and is ready', () => {
    expect(
      repoLogins('blog', [], {
        secret: null,
        logins: { github: 'missing', claude: 'missing', az: 'missing' },
      }),
    ).toEqual({
      repo: 'blog',
      needs: [],
      missing: [],
      unchecked: [],
      ready: true,
    });
  });

  test("Needs you's reason names only what is not usable, with its sign-in", () => {
    expect(
      repoLoginsReason(status({ github: 'ok', claude: 'ok', az: 'ok', aws: 'ok' })),
    ).toBeNull();
    expect(repoLoginsReason(status({ github: 'ok', claude: 'ok', az: 'ok', aws: 'expired' }))).toBe(
      "this repo needs logins that aren't usable here (its logins:). Sign in yourself in Terminal; the agent never types a password or reads a token:\n- aws (shop-test): expired, sign in with: abe login aws --profile shop-test",
    );
  });

  test('abe login status --repo prints the table under the logins', () => {
    const repo = status({ github: 'ok', claude: 'ok', az: 'ok', aws: 'missing' });

    expect(
      loginStatusText({
        secret: null,
        logins: { github: 'ok', claude: 'ok', az: 'ok', aws: 'missing' },
        awsProfile: 'shop-test',
        repo,
      }),
    ).toBe(
      [
        'github ok',
        'claude ok',
        'az     ok',
        'aws (shop-test) missing  (abe login aws --profile shop-test)',
        'kept in no secret: this abe serve stores no logins',
        'shop needs (logins:):',
        '  gh               ok · octocat',
        '  aws (shop-test)  missing  (abe login aws --profile shop-test)',
        '  claude           ok',
        'not here: aws',
        '',
      ].join('\n'),
    );
  });
});

describe("aws's config, stored for your boxes", () => {
  const MINE = [
    '[default]',
    'sso_session = corp',
    'sso_account_id = 999999999999',
    '',
    '[profile shop-test]',
    'sso_session = corp',
    'sso_account_id = 111111111111',
    'sso_role_name = Dev',
    'region = eu-north-1',
    '',
    '[sso-session corp]',
    'sso_start_url = https://corp.awsapps.com/start',
    'sso_region = eu-west-1',
    '',
    '[profile personal]',
    'region = us-east-1',
    '',
  ].join('\n');

  test('only the profile and its sso-session, never [default] or another profile', () => {
    expect(awsConfigFor(MINE, 'shop-test')).toBe(
      [
        '[profile shop-test]',
        'sso_session = corp',
        'sso_account_id = 111111111111',
        'sso_role_name = Dev',
        'region = eu-north-1',
        '',
        '[sso-session corp]',
        'sso_start_url = https://corp.awsapps.com/start',
        'sso_region = eu-west-1',
        '',
      ].join('\n'),
    );
    expect(awsConfigFor(MINE, 'nope')).toBeUndefined();
    expect(awsConfigFor(MINE, 'default')).toBeUndefined();
  });

  test.each([
    ["an sso-session profile: its session's name", 'shop-test', 'corp'],
    ['a legacy profile: its own start URL', 'legacy', 'https://old.awsapps.com/start'],
    // another session's token is never this profile's
    ['a profile naming a session not there: none', 'orphan', undefined],
    ['a profile with no SSO: none', 'personal', undefined],
    ['no such profile: none', 'nope', undefined],
  ])("the profile's own SSO token: %s", (_, profile, key) => {
    const config = `${MINE}\n[profile legacy]\nsso_start_url = https://old.awsapps.com/start\n\n[profile orphan]\nsso_session = gone\n`;

    expect(awsCacheKey(config, profile)).toBe(key);
  });

  test("a profile's sections join the stored ones, replacing their own", () => {
    expect(
      mergeAwsConfig(
        '[default]\nregion = x\n\n[profile old]\nregion = a\n',
        '[profile old]\nregion = b\n\n[profile new]\nregion = c\n',
      ),
    ).toBe('[profile old]\nregion = b\n\n[profile new]\nregion = c\n');
  });

  test.each([
    ['arn:aws:sts::111111111111:assumed-role/Dev/ada@example.com\n', 'ada@example.com'],
    ['arn:aws:iam::111111111111:user/ada', 'ada'],
    ['arn:aws:iam::111111111111:user/team/ada\n', 'ada'],
    ['arn:aws:iam::111111111111:root', undefined],
  ])('who %s is', (arn, who) => {
    expect(awsWho(arn)).toBe(who);
  });

  test.each([
    ['sso_session', '[profile p]\nsso_session = corp\n', '', 'sso'],
    ['a legacy sso_start_url', '[profile p]\nsso_start_url = https://x\n', '', 'sso'],
    ['keys in credentials', '', '[p]\naws_access_key_id = AKIA\n', 'keys'],
    ['a section with neither', '[profile p]\nregion = eu-west-1\n', '', 'keys'],
    ['named nowhere', '[profile q]\nregion = x\n', '[q]\naws_access_key_id = AKIA\n', 'unknown'],
  ] as const)('a profile with %s: its kind', (_, config, credentials, kind) => {
    expect(awsProfileKind(config, credentials, 'p')).toBe(kind);
  });

  test.each([
    ['p', false, 'aws sso login --profile p'],
    ['p', true, 'aws configure --profile p'],
    [null, false, 'aws sso login'],
  ] as const)('signing %p in (keys %p): %s', (profile, keys, command) => {
    expect(awsSignIn(profile, keys)).toBe(command);
  });
});

describe('abe login status’s text', () => {
  const logins = { github: 'missing', claude: 'expired', az: 'unchecked' } as const;
  const unchecked = { az: "az not found on serve's PATH" };

  test('with no logins secret (the Mac) it names each tool’s own login, as Problems does', () => {
    expect(loginStatusText({ secret: null, logins, unchecked })).toBe(
      [
        'github missing  (gh auth login --web)',
        'claude expired  (claude auth login)',
        "az     can't check: az not found on serve's PATH  (abe tools check)",
        'kept in no secret: this abe serve stores no logins',
        '',
      ].join('\n'),
    );
  });

  test('with a secret (a box) abe login stores what the tool wrote', () => {
    expect(loginStatusText({ secret: 'abe/o/logins', logins, unchecked })).toContain(
      'github missing  (abe login github)',
    );
  });
});

describe('az: its sign-in and the folder it was checked in', () => {
  const FIX = 'az login --allow-no-subscriptions';
  const at = (
    folder: AzLoginFolder | undefined,
    o: { secret?: string | null; said?: string } = {},
  ) => {
    const status = {
      secret: o.secret ?? null,
      logins: { github: 'ok', claude: 'ok', az: 'missing' } as const,
      ...(folder === undefined ? {} : { azureConfigDir: folder }),
      ...(o.said === undefined ? {} : { said: { az: o.said } }),
    };
    const repo = repoLogins('shop', loginNeeds(['az']), status);

    return {
      fix: repo.needs[0]?.fix,
      row: loginStatusText(status).split('\n')[2],
      reason: repoLoginsReason(repo)?.split('\n')[1],
    };
  };

  // Boards needs no Azure subscription; the folder in force goes in front
  test.each<[string, AzLoginFolder | undefined, string | null, string]>([
    ["az's own folder, locally", undefined, null, FIX],
    [
      "this checkout's folder",
      { from: 'checkout', dir: '/w/az' },
      null,
      `AZURE_CONFIG_DIR=/w/az ${FIX}`,
    ],
    [
      "serve's $AZURE_CONFIG_DIR",
      { from: 'environment', dir: '/e/az' },
      null,
      `AZURE_CONFIG_DIR=/e/az ${FIX}`,
    ],
    [
      'a box: abe login az, kept for your boxes',
      { from: 'checkout', dir: '/home/ada/az' },
      'abe/ada/logins',
      'abe login az',
    ],
  ])('the sign-in, %s', (_, folder, secret, fix) => {
    const said = at(folder, { secret });

    expect(LOGINS.az.login).toBe(FIX);
    expect([
      said.fix,
      said.row?.endsWith(`  (${fix})`),
      said.reason?.endsWith(`sign in with: ${fix}`),
    ]).toEqual([fix, true, true]);
  });

  test.each<[string, AzLoginFolder | undefined, string | undefined, string]>([
    ["az's own", undefined, undefined, "this checkout reads az's own folder (~/.azure)"],
    [
      "this checkout's under /private/tmp",
      { from: 'checkout', dir: '/private/tmp/az-work' },
      undefined,
      'this checkout reads az from /private/tmp/az-work (board.azureConfigDir here); /private/tmp/az-work is wiped on restart: use a folder under ~/.config (abe settings set board.azureConfigDir ~/.config/az --mine)',
    ],
    [
      "serve's under /tmp",
      { from: 'environment', dir: '/tmp' },
      undefined,
      "serve's $AZURE_CONFIG_DIR /tmp overrides the Layers; /tmp is wiped on restart: start abe serve with $AZURE_CONFIG_DIR under ~/.config, like ~/.config/az",
    ],
    [
      'a folder only named like /tmp',
      { from: 'checkout', dir: '/tmpdir/az' },
      undefined,
      'this checkout reads az from /tmpdir/az (board.azureConfigDir here)',
    ],
    [
      'what the check said',
      undefined,
      "ERROR: Please run 'az login' to setup account.",
      "this checkout reads az's own folder (~/.azure); az said: ERROR: Please run 'az login' to setup account.",
    ],
  ])('the row and the reason name the folder: %s', (_, folder, said, note) => {
    const fix = folder === undefined ? FIX : `AZURE_CONFIG_DIR=${folder.dir} ${FIX}`;

    expect(at(folder, said === undefined ? {} : { said })).toEqual({
      fix,
      row: `az     missing: ${note}  (${fix})`,
      reason: `- az: missing (${note}), sign in with: ${fix}`,
    });
  });

  test.each<[string, AzLoginFolder | undefined, string]>([
    ["az's own", undefined, "az's own folder (~/.azure)"],
    [
      "serve's",
      { from: 'environment', dir: '/e/az' },
      "serve's $AZURE_CONFIG_DIR /e/az overrides the Layers",
    ],
  ])('outside a checkout the row names no checkout: %s', (_, folder, note) => {
    const fix = folder === undefined ? FIX : `AZURE_CONFIG_DIR=${folder.dir} ${FIX}`;
    const status = {
      secret: null,
      logins: { github: 'ok', claude: 'ok', az: 'missing' } as const,
      outside: true as const,
      ...(folder === undefined ? {} : { azureConfigDir: folder }),
    };

    expect(loginStatusText(status).split('\n')[2]).toBe(`az     missing: ${note}  (${fix})`);
  });
});

test('every tool names where it keeps its login, under HOME', () => {
  for (const files of Object.values(LOGIN_FILES))
    for (const f of files) expect(f.startsWith('/') || f.includes('..')).toBe(false);
});

describe("Entra's refusals (#237)", () => {
  test.each([
    ['AADSTS530035: Access has been blocked by security defaults.', 'AADSTS530035'],
    ['ERROR: AADSTS53003: Access has been blocked by Conditional Access policies.', 'AADSTS53003'],
    ['AADSTS53000: Device is not in required device state', 'AADSTS53000'],
    ['AADSTS70043: The refresh token has expired', undefined],
    ['AADSTS5300399: something else', undefined],
  ])('%s', (text, code) => {
    expect(entraBlock(text)).toBe(code);
  });

  test('az signs in to a named tenant; the others take none', () => {
    expect(loginArgv('az', 'contoso.onmicrosoft.com')).toEqual([
      'az',
      'login',
      '--use-device-code',
      '--allow-no-subscriptions',
      '--tenant',
      'contoso.onmicrosoft.com',
    ]);
    expect(loginArgv('az')).toEqual(LOGIN_ARGV.az);
    expect(macAzLoginArgv('t1')).toEqual([
      'az',
      'login',
      '--allow-no-subscriptions',
      '--tenant',
      't1',
    ]);
  });
});
