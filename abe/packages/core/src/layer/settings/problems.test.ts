/** Problems first (#108): every problem worst first, its where-line and its way out. */
import { describe, expect, test } from 'bun:test';
import { type SettingProblem } from './contract';
import {
  isInfoRow,
  problemsOnly,
  settingsProblems,
  settingsProblemsText,
  type ProblemsInput,
} from './problems';
import { toolCheck } from '../../install/tools';
import { checkItems } from './logins-tools';
import { addChecks, checkEntries } from './checks';
import { coreDefaults } from './keys';

const scope = { repo: 'demo-shop', home: '/home/me' };

const problem = (p: Partial<SettingProblem> & Pick<SettingProblem, 'code'>): SettingProblem => ({
  layer: 'repo',
  file: '/work/demo-shop/abe.yaml',
  key: null,
  message: 'something',
  ...p,
});

const input = (o: Partial<ProblemsInput>): ProblemsInput => ({ settings: [], scope, ...o });

describe('settingsProblems', () => {
  test("a repo with no pack (#159): no check has a command, so a Factory run's checks run nothing", () => {
    const [none] = settingsProblems(
      input({ checks: { repo: 'newrepo', entries: checkEntries(coreDefaults().checks) } }),
    );

    expect(none).toEqual({
      kind: 'checks',
      code: 'no-checks',
      text: 'repo newrepo has no checks: tests, types, lint have no command, so a Factory run checks nothing before review — give each a run: command under checks: in abe.yaml (abe settings check . prints one from its scripts)',
      where: 'Factory policy › Checks · abe.yaml in newrepo',
      page: 'factory-policy',
      way: { kind: 'open', page: 'factory-policy', row: 'checks' },
    });
  });

  test("the Mac database (#349): Docker not there for a repo that needs one; serve's DATABASE_URL ignored", () => {
    const facts = { repo: 'demo-shop', needs: true, docker: 'down', served: true } as const;

    expect(settingsProblems(input({ database: facts })).map((p) => [p.code, p.text])).toEqual([
      [
        'docker-needed',
        "Docker isn't running: prototypes and local sessions of demo-shop need it for their database",
      ],
      [
        'database-url-ignored',
        "DATABASE_URL is set in serve's environment and is ignored (each session and prototype gets its own)",
      ],
    ]);
    expect(
      settingsProblems(input({ database: { ...facts, docker: 'missing', served: false } }))[0]
        ?.text,
    ).toStartWith("Docker isn't installed");
    // a repo that needs none, or Docker up: nothing
    expect(
      settingsProblems(input({ database: { ...facts, needs: false, served: false } })),
    ).toEqual([]);
    expect(
      settingsProblems(input({ database: { ...facts, docker: 'up', served: false } })),
    ).toEqual([]);
  });

  test('checks cut to the built-ins by an Override: no check is named with a command', () => {
    const [none] = settingsProblems(
      input({ checks: { repo: 'docs', entries: checkEntries(['no-deleted-tests']) } }),
    );

    expect(none?.text).toBe(
      'repo docs has no checks: none is named with a command, so a Factory run checks nothing before review — give each a run: command under checks: in abe.yaml (abe settings check . prints one from its scripts)',
    );
  });

  test('a check named with no command beside one that has is no problem: its result says so', () => {
    const entries = checkEntries(
      addChecks(coreDefaults().checks, [{ name: 'tests', run: 'bun test' }]),
    );

    expect(settingsProblems(input({ checks: { repo: 'demo-shop', entries } }))).toEqual([]);
  });

  test('a login expired, missing or blocked by Entra: what is wrong, where, and the way out', () => {
    const [expired, missing] = settingsProblems(
      input({
        logins: { secret: null, logins: { github: 'expired', claude: 'ok', az: 'missing' } },
      }),
    );

    expect(expired).toEqual({
      kind: 'login',
      code: 'login-expired',
      text: 'GitHub login expired — sign in again',
      where: 'Logins & tools › GitHub · gh auth status',
      page: 'logins-tools',
      way: { kind: 'fix', command: 'gh auth login --web' },
    });
    expect(missing).toMatchObject({
      code: 'login-missing',
      text: 'Azure DevOps login missing — sign in',
      way: { kind: 'fix', command: 'az login --allow-no-subscriptions' },
    });
    // Entra refused it (#237): blocked, as its Logins row says, with no sign-in fix
    expect(
      settingsProblems(
        input({
          logins: {
            secret: null,
            logins: { github: 'ok', claude: 'ok', az: 'expired' },
            blocked: { az: 'AADSTS53003' },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'login',
        code: 'login-blocked',
        text: "Azure DevOps login blocked by Entra: Microsoft Entra's Conditional Access blocked this sign-in (AADSTS53003): a policy refuses this device or place. An Entra admin must allow it.",
        where: 'Logins & tools › Azure DevOps · az account get-access-token',
        page: 'logins-tools',
        way: { kind: 'open', page: 'logins-tools', row: null },
      },
    ]);
  });

  test("#160: a login whose tool can't run is not checked, never expired: its tool row says why", () => {
    expect(
      settingsProblems(
        input({
          logins: {
            secret: null,
            logins: { github: 'unchecked', claude: 'ok', az: 'ok' },
            unchecked: { github: "gh not found on serve's PATH" },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'login',
        code: 'login-unchecked',
        text: "GitHub login can't be checked: gh not found on serve's PATH",
        where: 'Logins & tools › GitHub · gh auth status',
        page: 'logins-tools',
        way: { kind: 'open', page: 'logins-tools', row: 'tools' },
      },
    ]);
  });

  test('a check’s output is shown without its terminal codes (#345)', () => {
    const said = '\u001b[?2004hDo you trust the files in this folder?\u001b[0m';
    const [p] = settingsProblems(
      input({
        logins: {
          secret: null,
          logins: { github: 'ok', claude: 'unchecked', az: 'ok' },
          unchecked: { claude: `claude auth status failed: ${said}` },
        },
      }),
    );

    expect(p?.text).toBe(
      "Claude login can't be checked: claude auth status failed: Do you trust the files in this folder?",
    );
    const rows = checkItems({
      logins: {
        secret: null,
        logins: { github: 'ok', claude: 'unchecked', az: 'ok' },
        unchecked: { claude: `failed: [?2004h${said}` },
      },
    });

    expect(rows.find((r) => r.id === 'login:claude')?.state).toBe(
      "⚠ can't check: failed: Do you trust the files in this folder?",
    );
  });

  test('an AWS SSO session expired: its sso-session and the sign-in to run', () => {
    expect(settingsProblems(input({ awsSso: { session: 'abe', state: 'expired' } }))).toEqual([
      {
        kind: 'login',
        code: 'login-expired',
        text: 'AWS SSO session expired — sign in again',
        where: 'Logins & tools › AWS SSO · sso-session abe',
        page: 'logins-tools',
        way: { kind: 'fix', command: 'aws sso login --sso-session abe' },
      },
    ]);
  });

  test("with a login secret the fix is abe's own login, which stores it", () => {
    const [p] = settingsProblems(
      input({
        logins: { secret: 'abe/me/logins', logins: { github: 'ok', claude: 'expired', az: 'ok' } },
      }),
    );

    expect(p?.way).toEqual({ kind: 'fix', command: 'abe login claude' });
  });

  test('a tool not found or too old: the check it ran, and the install or upgrade', () => {
    const [missing, old] = settingsProblems(
      input({
        tools: [
          toolCheck('node', { found: false }, false),
          toolCheck(
            'git',
            { found: true, exit: 0, stdout: 'git version 2.47.1\n', stderr: '' },
            false,
          ),
          toolCheck('node', { found: true, exit: 0, stdout: 'v16.20.0\n', stderr: '' }, false),
        ],
      }),
    );

    expect(missing).toEqual({
      kind: 'tool',
      code: 'tool-missing',
      text: "node not found on serve's PATH",
      where: 'Logins & tools › node · command -v node, as abe serve runs it',
      page: 'logins-tools',
      way: { kind: 'fix', command: 'brew install node' },
    });
    expect(old).toMatchObject({
      code: 'tool-old',
      text: 'node 16.20.0 is too old: 18 or newer',
      way: { kind: 'fix', command: 'brew upgrade node' },
    });
  });

  test("a Mac without Docker has no problem (#164); a box's Docker down is one", () => {
    const docker = (onBox: boolean) => [
      toolCheck('docker', { found: false }, onBox),
      toolCheck('docker', { found: true, exit: 1, stdout: '', stderr: 'down' }, onBox),
    ];

    expect(settingsProblems(input({ tools: docker(false) }))).toEqual([]);
    expect(settingsProblems(input({ tools: docker(true) })).map((p) => p.code)).toEqual([
      'tool-missing',
      'tool-failed',
    ]);
  });

  test('on a box a tool has no fix here: the way out opens Logins & tools', () => {
    const [p] = settingsProblems(input({ tools: [toolCheck('tmux', { found: false }, true)] }));

    expect(p?.way).toEqual({ kind: 'open', page: 'logins-tools', row: 'tools' });
  });

  test('an Override without a reason in a repo file opens its row', () => {
    const [p] = settingsProblems(
      input({
        settings: [
          problem({
            code: 'reason-required',
            key: 'autoMerge',
            message: 'an Override needs a non-empty reason',
          }),
        ],
      }),
    );

    expect(p).toEqual({
      kind: 'override-reason',
      code: 'reason-required',
      text: 'Override without a reason: auto merge overridden by repo demo-shop — add the reason or remove the override',
      where: 'Factory policy › Auto merge · abe.yaml in demo-shop',
      page: 'factory-policy',
      way: { kind: 'open', page: 'factory-policy', row: 'autoMerge' },
    });
  });

  test('a Layer file that does not read opens the file (#126)', () => {
    const [p] = settingsProblems(
      input({
        settings: [
          problem({
            code: 'bad-layer-file',
            layer: 'individual',
            file: '/work/demo-shop/.abe/settings.local.yaml',
            message: 'bad indentation',
          }),
        ],
      }),
    );

    expect(p).toEqual({
      kind: 'layer-file',
      code: 'bad-layer-file',
      text: '.abe/settings.local.yaml in demo-shop does not read: bad indentation',
      where: 'Layers › .abe/settings.local.yaml in demo-shop',
      page: 'layers',
      way: { kind: 'file', path: '/work/demo-shop/.abe/settings.local.yaml' },
    });
  });

  test('a workflow file failing its load check (#15) opens the file; it is not run', () => {
    const [p] = settingsProblems(
      input({
        workflows: [
          {
            workflow: 'ui-bug',
            layer: 'yours',
            file: '/home/me/.config/abe/workflows/ui-bug.yaml',
            line: 7,
            code: 'needs-build',
            text: 'Verify needs a build step before it',
            fix: null,
          },
        ],
      }),
    );

    expect(p).toEqual({
      kind: 'layer-file',
      code: 'workflow-problem',
      text: "Can't run ui-bug.yaml: line 7, verify needs a build step before it",
      where: 'Layers › workflows/ui-bug.yaml · yours',
      page: 'layers',
      way: { kind: 'file', path: '/home/me/.config/abe/workflows/ui-bug.yaml' },
    });
  });

  test('a setting dropped by the merge says why and opens its row (an unknown one: its file)', () => {
    const problems = settingsProblems(
      input({
        settings: [
          problem({
            code: 'not-in-repo',
            key: 'githubIdentity',
            message: 'githubIdentity is yours on this machine',
          }),
          problem({ code: 'unknown-setting', key: 'colour', message: 'colour is not a setting' }),
          problem({
            code: 'write-below-repo',
            layer: 'individual',
            file: '/work/demo-shop/.abe/settings.local.yaml',
            key: 'reach',
            message:
              "reach grants the write name ABE_DB_WRITE_TEST: only the repo's settings.yaml grants a write; the repo value stays in force",
          }),
          problem({
            code: 'personal-only',
            key: 'agents.prod',
            message: 'agents.prod is yours alone',
          }),
          problem({
            code: 'unknown-node',
            layer: 'individual',
            file: '/home/me/.config/abe/settings.yaml',
            key: 'views',
            message: 'factory has no node lane:Nope',
          }),
        ],
      }),
    );

    expect(problems.map((p) => [p.kind, p.code, p.text, p.way])).toEqual([
      [
        'dropped',
        'not-in-repo',
        'GitHub login in repo demo-shop is dropped: githubIdentity is yours on this machine',
        { kind: 'open', page: 'board-team', row: 'githubIdentity' },
      ],
      [
        'dropped',
        'unknown-setting',
        'colour in repo demo-shop is dropped: colour is not a setting',
        { kind: 'file', path: '/work/demo-shop/abe.yaml' },
      ],
      [
        'dropped',
        'write-below-repo',
        "Reaches in yours for demo-shop is dropped: reach grants the write name ABE_DB_WRITE_TEST: only the repo's settings.yaml grants a write; the repo value stays in force",
        { kind: 'open', page: 'reach', row: 'reach' },
      ],
      [
        'dropped',
        'personal-only',
        'prod in repo demo-shop is dropped: agents.prod is yours alone',
        { kind: 'open', page: 'agents', row: 'agents.prod' },
      ],
      [
        'dropped',
        'unknown-node',
        'View tweaks in yours is dropped: factory has no node lane:Nope',
        { kind: 'open', page: 'appearance', row: 'views' },
      ],
    ]);
    expect(problems[2]?.where).toBe('Reach › Reaches · .abe/settings.local.yaml in demo-shop');
    expect(problems[4]?.where).toBe('Appearance › View tweaks · ~/.config/abe/settings.yaml');
  });

  test('a theme no one has (#172): the Layer that names it, what is drawn, and abe theme list', () => {
    const [p] = settingsProblems(
      input({
        settings: [
          problem({
            code: 'unknown-theme',
            layer: 'individual',
            file: '/home/me/.config/abe/settings.yaml',
            key: 'ui.theme',
            message:
              'no theme no-such-theme, so Islands Dark is drawn; the themes: islands-dark, islands-light',
          }),
        ],
      }),
    );

    expect(p).toEqual({
      kind: 'dropped',
      code: 'unknown-theme',
      text: 'Theme in yours names no theme no-such-theme, so Islands Dark is drawn; the themes: islands-dark, islands-light',
      where: 'Appearance › Theme · ~/.config/abe/settings.yaml',
      page: 'appearance',
      way: { kind: 'fix', command: 'abe theme list' },
    });
  });

  test('worst first: logins, tools, Overrides without a reason, files, then dropped settings', () => {
    const kinds = settingsProblems({
      scope,
      settings: [
        problem({ code: 'unknown-setting', key: 'x', message: 'x is not a setting' }),
        problem({ code: 'bad-layer-file', message: 'bad' }),
        problem({ code: 'reason-required', key: 'autoMerge', message: 'no reason' }),
      ],
      tools: [toolCheck('rg', { found: false }, false)],
      logins: { secret: null, logins: { github: 'ok', claude: 'missing', az: 'ok' } },
    }).map((p) => p.kind);

    expect(kinds).toEqual(['login', 'tool', 'override-reason', 'layer-file', 'dropped']);
  });

  test('ok logins and tools are no problem; the text ends on its last line', () => {
    const none = settingsProblems(
      input({
        logins: { secret: null, logins: { github: 'ok', claude: 'ok', az: 'ok' } },
        tools: [
          toolCheck(
            'git',
            { found: true, exit: 0, stdout: 'git version 2.47.1', stderr: '' },
            false,
          ),
        ],
      }),
    );

    expect(none).toEqual([]);
    expect(settingsProblemsText({ problems: none, checked: { logins: true, tools: true } })).toBe(
      'No problems\n',
    );
    const one = settingsProblems(input({ tools: [toolCheck('rg', { found: false }, false)] }));

    expect(settingsProblemsText({ problems: one, checked: { logins: false, tools: true } })).toBe(
      [
        "! rg not found on serve's PATH",
        '    Logins & tools › rg · command -v rg, as abe serve runs it',
        '    fix: brew install ripgrep',
        'No other problems (logins not checked)',
        '',
      ].join('\n'),
    );
  });
});

describe('your Overrides: an info row each on Problems, never a problem (#168)', () => {
  const mine = {
    key: 'autoMerge',
    value: true,
    shown: 'on',
    reason: 'my sandbox',
    since: '2026-10-24T09:30:00.000Z',
  } as const;

  test('what it is, why, since when; the way out suggests proposing it, never required', () => {
    const rows = settingsProblems(input({ overrides: [mine] }));

    expect(rows).toEqual([
      {
        kind: 'override',
        code: 'personal-override',
        text: 'Your Override: auto merge on — my sandbox (since 2026-10-24); it holds for your runs only',
        where: 'Factory policy › Auto merge · your Layer',
        page: 'factory-policy',
        way: {
          kind: 'fix',
          command: "abe settings propose autoMerge true --reason 'my sandbox'",
        },
      },
    ]);
    expect(rows.map(isInfoRow)).toEqual([true]);
  });

  test('after every problem, which alone count', () => {
    const rows = settingsProblems(
      input({
        overrides: [{ ...mine, since: null }],
        settings: [problem({ code: 'unknown-setting', key: 'colour', message: 'nope' })],
      }),
    );

    expect(rows.map((p) => [p.kind, isInfoRow(p)])).toEqual([
      ['dropped', false],
      ['override', true],
    ]);
    expect(rows[1]?.text).toBe(
      'Your Override: auto merge on — my sandbox; it holds for your runs only',
    );
    expect(problemsOnly(rows)).toHaveLength(1);
  });

  test('the text output marks it as info', () => {
    const text = settingsProblemsText({
      problems: settingsProblems(input({ overrides: [mine] })),
      checked: { logins: true, tools: true },
    });

    expect(text).toBe(
      [
        'i Your Override: auto merge on — my sandbox (since 2026-10-24); it holds for your runs only',
        '    Factory policy › Auto merge · your Layer',
        "    suggest: abe settings propose autoMerge true --reason 'my sandbox'",
        'No problems',
        '',
      ].join('\n'),
    );
  });
});

describe('browser profiles (#127, #345)', () => {
  const row = (name: string, storedAt: string | null, folder = true) => ({
    name,
    purpose: `${name} for tests`,
    layer: 'repo' as const,
    default: false,
    storedAt,
    folder,
    open: null,
    storedAgo: null,
    storeFailed: null,
  });
  const list = (
    profiles: ReturnType<typeof row>[],
    missingDefault: string | null = null,
  ): NonNullable<ProblemsInput['browser']>['list'] => ({
    profiles: [
      ...profiles,
      {
        name: 'default',
        purpose: 'empty · a fresh profile every start',
        layer: 'built-in',
        default: missingDefault !== null,
        storedAt: null,
        folder: null,
        open: null,
        storedAgo: null,
        storeFailed: null,
      },
    ],
    unlisted: [],
    migrated: [],
    missingDefault,
  });

  test('browser.default naming a profile no Layer has, and a profile never stored', () => {
    const ps = settingsProblems(
      input({
        browser: {
          list: list(
            [row('shop-admin', '2026-10-20T08:00:00.000Z'), row('shop-buyer', null)],
            'old',
          ),
          stored: true,
        },
      }),
    );

    expect(ps).toEqual([
      {
        kind: 'browser',
        code: 'browser-default-missing',
        text: 'browser.default names old, which no Layer has: a launch with no --profile starts the empty default — pick one in Default profile',
        where: 'Browser profiles › Default profile',
        page: 'browser-profiles',
        way: { kind: 'open', page: 'browser-profiles', row: 'browser.default' },
      },
      {
        kind: 'browser',
        code: 'browser-not-stored',
        text: 'shop-buyer has no sign-ins stored: a box starts it signed out — abe browser open shop-buyer, sign in, then abe browser store shop-buyer',
        where: 'Browser profiles › Profiles · shop-buyer',
        page: 'browser-profiles',
        way: { kind: 'fix', command: 'abe browser open shop-buyer' },
      },
    ]);
  });

  test('nothing said of sign-ins while the store does not read, of one never opened here, of the built-in default', () => {
    expect(
      settingsProblems(
        input({ browser: { list: list([row('shop-buyer', null)]), stored: false } }),
      ),
    ).toEqual([]);
    expect(
      settingsProblems(
        input({ browser: { list: list([row('shop-buyer', null, false)]), stored: true } }),
      ),
    ).toEqual([]);
    expect(settingsProblems(input({ browser: { list: list([]), stored: true } }))).toEqual([]);
  });
});
