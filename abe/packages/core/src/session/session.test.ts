import { describe, expect, test } from 'bun:test';
import {
  claudeArgv,
  withRepoMcpOff,
  figmaServers,
  factoryLaunchPrompt,
  HOOK_EVENTS,
  hookSettings,
  isSessionSocket,
  launchPrompt,
  onThisMachineLine,
  MERGE_DENY,
  NO_START,
  NO_START_MAX,
  noStartReason,
  SANDBOX_DOMAINS,
  SESSION_START_TIMEOUT_MS,
  sessionBoundary,
  startBy,
  startOverdue,
  worktreePath,
  sessionEnv,
  sessionSendText,
  sessionListText,
  sessionStopText,
  sessionSettings,
  FACTORY_PERMISSION_MODE,
  type SessionState,
  withWorktreeHeld,
  SessionData,
  SessionMeta,
  withKind,
} from './session';
import type { SessionMcp } from '../layer/settings';

/** A Mac session's boundary, for the settings tests that are about something else. */
const BOUNDARY = sessionBoundary({
  state: '/state',
  serveSocket: '/state/serve.sock',
  plugins: '/plugins',
  socket: '/state/sessions/4-a1b2/session.sock',
  checkout: '/src/shop',
  home: '/home/kim',
});

describe('startOverdue: a launched claude that never ran a hook', () => {
  const at = Date.parse('2026-10-01T09:00:00.000Z');
  const by = startBy(at);
  const rows: [string, { state: SessionState; startBy: string | null }, number, boolean][] = [
    ['no hook yet, inside the timeout', { state: 'working', startBy: by }, at + 59_999, false],
    ['no hook yet, the timeout reached', { state: 'working', startBy: by }, at + 60_000, true],
    ['a hook came (startBy cleared)', { state: 'working', startBy: null }, at + 3_600_000, false],
    ['ended already', { state: 'ended', startBy: by }, at + 3_600_000, false],
  ];

  test.each(rows)('%s', (_, meta, now, overdue) => {
    expect(startOverdue(meta, now)).toBe(overdue);
  });
  test('startBy: the launch plus the start timeout, a minute', () => {
    expect(SESSION_START_TIMEOUT_MS).toBe(60_000);
    expect(by).toBe('2026-10-01T09:01:00.000Z');
  });
  test('the reason names the timeout and the hook that never came', () => {
    expect(NO_START).toBe(
      "its claude did not start: no SessionStart hook within 60 s (an error or a dialog before Claude Code's hooks run)",
    );
    expect(noStartReason(undefined)).toBe(NO_START);
    expect(noStartReason('\n  \n')).toBe(NO_START);
  });
  test("#190: with its screen read, the reason says what it showed: the dialog's lines", () => {
    const screen = [
      '',
      '\u001b[1m Settings Error\u001b[22m',
      '',
      ' /private/tmp/aqf/s/sessions/901-a3b8/settings.json',
      '  └ hooks',
      '    ├ ConfigChange: Invalid key in record',
      '    ├ CwdChanged: Invalid key in record',
      '    └ StopFailure: Invalid key in record',
      '',
      ' ❯ 1. Exit and fix manually',
      '   2. Continue without these settings',
      '',
    ].join('\n');

    expect(noStartReason(screen)).toBe(
      'its claude did not start: no SessionStart hook within 60 s; it stopped at: Settings Error · /private/tmp/aqf/s/sessions/901-a3b8/settings.json · hooks · ConfigChange: Invalid key in record · CwdChanged: Invalid key in record · StopFailure: Invalid key in record · 1. Exit and fix manually · 2. Continue without these settings',
    );
  });
  test('a long screen is cut, its first lines kept', () => {
    const reason = noStartReason(
      Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'),
    );

    expect(reason.length).toBeLessThanOrEqual(NO_START_MAX);
    expect(reason).toContain('it stopped at: line 0 ');
    expect(reason.endsWith('…')).toBe(true);
  });
});

test('worktreePath: beside the main checkout', () => {
  expect(worktreePath('/p/demo', 'card/4-sign-in')).toBe('/p/demo-wt/4-sign-in');
  expect(worktreePath('/p/demo/', 'card/7')).toBe('/p/demo-wt/7');
});

test('launchPrompt: the card title, description and acceptance criteria', () => {
  expect(
    launchPrompt({
      id: 4,
      title: 'Sign in',
      description: '## Why\n\nAccounts.\n',
      acceptanceCriteria: '- a wrong password is refused\n',
    }),
  ).toBe(
    'Work on card AB#4: Sign in\n\n## Why\n\nAccounts.\n\n## Acceptance criteria\n\n- a wrong password is refused',
  );
  expect(
    launchPrompt({ id: 6, title: 'No why', description: '', acceptanceCriteria: '- it works' }),
  ).toBe('Work on card AB#6: No why\n\n## Acceptance criteria\n\n- it works');
  expect(launchPrompt({ id: 5, title: 'Bare', description: '  ', acceptanceCriteria: ' ' })).toBe(
    'Work on card AB#5: Bare',
  );
  // a board on this machine: its own name, and never AB#, which GitHub links to Azure's card
  expect(
    launchPrompt({
      id: 5,
      title: 'Bare',
      description: '',
      acceptanceCriteria: '',
      board: { provider: 'local' },
    }),
  ).toBe(`Work on card L-5: Bare\n\n${onThisMachineLine(5)}`);
  expect(onThisMachineLine(5)).toContain('never AB#5');
});

test("factoryLaunchPrompt: core plugin's factory skill invoked on the card", () => {
  expect(
    factoryLaunchPrompt({
      id: 4,
      title: 'Sign in',
      description: 'Accounts.',
      acceptanceCriteria: '',
    }),
  ).toBe('/abe:factory Work on card AB#4: Sign in\n\nAccounts.');
});

test("sessionSettings with skillsOnTop on: the person's CLAUDE.md loads", () => {
  const settings = sessionSettings({
    abe: 'abe',
    models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
    allowedModels: ['opus'],
    allow: [],
    boundary: BOUNDARY,
    skillsOnTop: true,
    home: '/home/kim',
  });

  expect(settings).not.toHaveProperty('claudeMdExcludes');
});

describe('claudeArgv: skillsOnTop', () => {
  const argv = (skillsOnTop: boolean) =>
    claudeArgv({
      claude: 'claude',
      settings: 's.json',
      pluginDir: 'plugin',
      skillsOnTop,
      mcpMode: 'yours',
      claudeSession: 'id',
      instructions: 'core',
      prompt: 'go',
    });

  test("off: only the project's and local setting sources, so no personal skills, plugins or CLAUDE.md", () => {
    const a = argv(false);

    expect(a[a.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(a.slice(a.indexOf('--plugin-dir'), a.indexOf('--plugin-dir') + 2)).toEqual([
      '--plugin-dir',
      'plugin',
    ]);
    expect(a.at(-1)).toBe('go');
  });

  test("on: every setting source, the person's own too", () => {
    expect(argv(true)).not.toContain('--setting-sources');
  });

  test.each([true, false])(
    "skillsOnTop %p: never Claude in Chrome, the person's own browser with their sign-ins",
    (on) => {
      expect(argv(on)).toContain('--no-chrome');
    },
  );
});

describe("claudeArgv: the MCP servers a launch loads, Abe's and the person's own, never a repo's", () => {
  const PERSONAL = '/home/kim/.claude.json';
  const argv = (o: {
    mcpMode: SessionMcp;
    skillsOnTop?: boolean;
    personalMcp?: string;
    mcpConfig?: string;
    sourceMcp?: string[];
  }) =>
    claudeArgv({
      claude: 'claude',
      settings: 's.json',
      pluginDir: 'plugin',
      skillsOnTop: o.skillsOnTop ?? false,
      mcpMode: o.mcpMode,
      ...(o.personalMcp === undefined ? {} : { personalMcp: o.personalMcp }),
      ...(o.mcpConfig === undefined ? {} : { mcpConfig: o.mcpConfig }),
      ...(o.sourceMcp === undefined ? {} : { sourceMcp: o.sourceMcp }),
      claudeSession: 'id',
      instructions: 'core',
      prompt: 'go',
    });
  /** The files after `--mcp-config` (it is variadic: every word up to the next option). */
  const configs = (a: string[]) => {
    const at = a.indexOf('--mcp-config');

    if (at === -1) return [];
    const end = a.findIndex((word, i) => i > at && word.startsWith('--'));

    return a.slice(at + 1, end);
  };

  // one row per session kind: its mode and files as serve and the runner hand them in. A chat
  // of yours is not strict (your claude.ai connectors load); its settings reject the repo's own
  // servers (`withRepoMcpOff`). Every other kind is strict.
  test.each<[string, Parameters<typeof argv>[0], string[], boolean]>([
    [
      'a chat of yours, session.mcp yours: your own servers, your connectors',
      { mcpMode: 'yours', personalMcp: PERSONAL },
      [PERSONAL],
      false,
    ],
    [
      'a chat of yours with skillsOnTop on: the user source loads yours',
      { mcpMode: 'yours', skillsOnTop: true, personalMcp: PERSONAL },
      [],
      false,
    ],
    [
      "a chat with Abe's browser: Abe's, then yours",
      { mcpMode: 'yours', personalMcp: PERSONAL, mcpConfig: 'browser.json' },
      ['browser.json', PERSONAL],
      false,
    ],
    [
      'a chat, session.mcp abe-only: strict, none of yours',
      { mcpMode: 'abe-only', personalMcp: PERSONAL },
      [],
      true,
    ],
    ["a card's or an install's session: Abe's alone, strict", { mcpMode: 'abe-only' }, [], true],
    [
      "a Factory run with its browser and a source of yours: the source's file, then Abe's, strict",
      {
        mcpMode: 'abe-only',
        personalMcp: PERSONAL,
        sourceMcp: [PERSONAL],
        mcpConfig: 'browser.json',
      },
      [PERSONAL, 'browser.json'],
      true,
    ],
    [
      "a box's session with a source in the box's config, strict",
      { mcpMode: 'abe-only', sourceMcp: ['/home/abe/.claude.json'] },
      ['/home/abe/.claude.json'],
      true,
    ],
  ])('%s', (_, o, files, strict) => {
    const a = argv(o);

    expect(configs(a)).toEqual(files);
    expect(a.filter((w) => w === '--strict-mcp-config')).toEqual(
      strict ? ['--strict-mcp-config'] : [],
    );
    expect(a.at(-1)).toBe('go');
  });

  test('the files then an option, so the prompt is never read as a config', () => {
    const a = argv({ mcpMode: 'yours', personalMcp: PERSONAL, mcpConfig: 'browser.json' });

    expect(a[a.indexOf('--mcp-config') + 3]).toBe('--append-system-prompt');
  });

  test.each<[string, Record<string, unknown>, string[]]>([
    ['by its name', { figma: { type: 'http', url: 'https://example.test/x' } }, ['figma']],
    [
      "Figma's remote server under another name",
      { design: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
      ['design'],
    ],
    [
      "the desktop app's",
      { 'figma-dev-mode-mcp-server': { url: 'http://127.0.0.1:3845/mcp' } },
      ['figma-dev-mode-mcp-server'],
    ],
    [
      'never the others',
      { sentry: { url: 'https://mcp.sentry.dev/mcp' }, docs: { command: 'docs-mcp' } },
      [],
    ],
    ['a host only like it', { x: { url: 'https://mcp.figma.com.example.test/mcp' } }, []],
  ])("a prototype session's own Figma server, whatever session.mcp: %s", (_, servers, names) => {
    expect(figmaServers(servers)).toEqual(names);
  });

  test.each<[string, string[]]>([
    ["the repo's .mcp.json servers: none approved, each rejected", ['docs', 'db']],
    ['no .mcp.json: none approved all the same', []],
  ])("a chat of yours: the repo's own servers off in its settings, %s", (_, names) => {
    expect(withRepoMcpOff({ model: 'opus' }, names)).toEqual({
      model: 'opus',
      enableAllProjectMcpServers: false,
      disabledMcpjsonServers: names,
    });
  });
});

describe('sessionEnv', () => {
  const parent = {
    HOME: '/home/me',
    USER: 'me',
    LOGNAME: 'me',
    PATH: '/usr/bin:/bin',
    TERM: 'xterm-ghostty',
    LANG: 'sv_SE.UTF-8',
    LC_CTYPE: 'UTF-8',
    SHELL: '/bin/zsh',
    GITHUB_TOKEN: 'never',
    AWS_PROFILE: 'admin',
    ABE_STATE_DIR: '/state',
  };

  test('only the allowlist, its socket and the read names', () => {
    expect(
      sessionEnv({
        parent,
        bin: '/state/bin',
        socket: '/state/sessions/4-a1b2/session.sock',
        reach: { ABE_AWS_READ_TEST: 'abe-read-test', ABE_DB_READ_URL_TEST: 'postgres://r@db/x' },
      }),
    ).toEqual({
      ok: true,
      env: {
        HOME: '/home/me',
        USER: 'me',
        SHELL: '/bin/zsh',
        PATH: '/state/bin:/usr/bin:/bin',
        TERM: 'xterm-256color',
        LANG: 'sv_SE.UTF-8',
        LC_CTYPE: 'UTF-8',
        ABE_SOCKET: '/state/sessions/4-a1b2/session.sock',
        ABE_AWS_READ_TEST: 'abe-read-test',
        ABE_DB_READ_URL_TEST: 'postgres://r@db/x',
      },
    });
  });

  test("a local workspace's database: serve's DATABASE_URL, never another variable of its", () => {
    const env = sessionEnv({
      parent: { ...parent, DATABASE_URL: 'postgres://shop:shop@127.0.0.1/shop' },
      bin: '/b',
      socket: '/s',
      reach: {},
    });

    expect(env.ok && env.env.DATABASE_URL).toBe('postgres://shop:shop@127.0.0.1/shop');
    expect(env.ok && Object.keys(env.env).sort()).toEqual(
      [
        'ABE_SOCKET',
        'DATABASE_URL',
        'HOME',
        'LANG',
        'LC_CTYPE',
        'PATH',
        'SHELL',
        'TERM',
        'USER',
      ].sort(),
    );
  });

  test('a UTF-8 locale when serve has none', () => {
    const env = sessionEnv({
      parent: { HOME: '/h', PATH: '/bin' },
      bin: '/b',
      socket: '/s',
      reach: {},
    });

    expect(env.ok && env.env.LANG).toBe('en_US.UTF-8');
  });

  test('a write name is refused, and so is anything not ABE_', () => {
    const base = { parent, bin: '/b', socket: '/s' };

    expect(sessionEnv({ ...base, reach: { ABE_AWS_WRITE_TEST: 'abe-write-test' } })).toMatchObject({
      ok: false,
      code: 'write-name',
    });
    expect(sessionEnv({ ...base, reach: { GITHUB_TOKEN: 'x' } })).toMatchObject({
      ok: false,
      code: 'not-reach',
    });
  });
});

test('hookSettings: abe hook for every event, none for the worktree hooks', () => {
  const settings = hookSettings("'/state/bin/abe'");

  expect(Object.keys(settings.hooks)).toEqual([...HOOK_EVENTS]);
  expect(settings.hooks.Stop).toEqual([
    { hooks: [{ type: 'command', command: "'/state/bin/abe' hook Stop", timeout: 5 }] },
  ]);
  expect(Object.keys(settings.hooks)).not.toContain('WorktreeCreate');
});

test.each([
  ['/state/sessions/4-a1b2/session.sock', true],
  ['/state/serve.sock', false],
  ['/state/session.sock.bak', false],
])('isSessionSocket %s → %p', (path, is) => {
  expect(isSessionSocket(path)).toBe(is);
});

test('sessionSettings: the hooks, the coordinator model, allowedModels held, worktrees off HEAD', () => {
  const settings = sessionSettings({
    abe: 'abe',
    models: { coordinator: 'sonnet', reader: 'sonnet', writer: 'sonnet' },
    allowedModels: ['sonnet'],
    allow: ['Bash(abe factory decide:*)'],
    boundary: BOUNDARY,
    skillsOnTop: false,
    home: '/home/kim',
  });

  expect(settings).toMatchObject({
    model: 'sonnet',
    availableModels: ['sonnet'],
    // `abe session model` picks from these rows, for this session only (#180)
    modelPicker: { replaceBuiltInOptions: true, options: [{ model: 'sonnet', label: 'sonnet' }] },
    worktree: { baseRef: 'head' },
    permissions: { allow: ['Bash(abe factory decide:*)'] },
    // A repo under HOME would load ~/.claude/CLAUDE.md as an ancestor's: kept out.
    claudeMdExcludes: ['/home/kim/.claude/**'],
    // Claude Code's own Co-Authored-By trailer and PR footer stay out: the repo's commit style rules.
    attribution: { commit: '', pr: '' },
  });
  expect(Object.keys(settings.hooks ?? {})).toEqual([...HOOK_EVENTS]);
});

describe('sessionBoundary: what a local session reaches (ADR 0020 CC6)', () => {
  const at = {
    state: '/home/kim/.local/state/abe',
    serveSocket: '/home/kim/.local/state/abe/serve.sock',
    plugins: '/home/kim/.cache/abe/plugins',
    socket: '/home/kim/.local/state/abe/sessions/4-a1b2/session.sock',
    checkout: '/home/kim/src/shop',
    home: '/home/kim',
  };

  test('Bash jailed on environment access only: the state hidden but its abe and own folder, what decides its reach never written', () => {
    expect(sessionBoundary(at)).toEqual({
      directories: ['/home/kim/src/shop/.claude/worktrees'],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          denyRead: ['/home/kim/.local/state/abe'],
          allowRead: [
            '/home/kim/.local/state/abe/bin',
            '/home/kim/.local/state/abe/sessions/4-a1b2',
          ],
          denyWrite: [
            '/home/kim/.local/state/abe',
            '/home/kim/.cache/abe/plugins',
            // What decides its reach (ADR 0029): the repo's settings, yours, the Abe env files;
            // all else is written.
            '/home/kim/src/shop/abe.yaml',
            '/home/kim/src/shop/.abe/settings.local.yaml',
            '/home/kim/src/shop/.abe/abe.*.env',
            '/home/kim/src/shop/.claude/worktrees/*/.abe/settings.local.yaml',
            '/home/kim/src/shop/.claude/worktrees/*/.abe/abe.*.env',
            // The main checkout's git config and hooks: serve's own git runs them, unjailed.
            '/home/kim/src/shop/.git/config',
            '/home/kim/src/shop/.git/hooks',
            '/home/kim/src/shop/.git/config.worktree',
            '/home/kim/src/shop/.git/worktrees/*/config.worktree',
          ],
        },
        network: {
          allowUnixSockets: ['/home/kim/.local/state/abe/sessions/4-a1b2/session.sock'],
          allowLocalBinding: true,
          allowedDomains: [...SANDBOX_DOMAINS],
          // Any other host refused by the sandbox itself, never asked of the auto classifier (#181).
          strictAllowlist: true,
          // Go's TLS (gh) verifies through trustd (#195).
          allowMachLookup: ['com.apple.trustd.agent'],
        },
      },
      deny: [
        'Read(//home/kim/.local/state/abe/**)',
        'Edit(//home/kim/.local/state/abe/**)',
        'Edit(//home/kim/.cache/abe/plugins/**)',
        'Edit(//home/kim/src/shop/abe.yaml)',
        'Edit(//home/kim/src/shop/.abe/settings.local.yaml)',
        'Edit(//home/kim/src/shop/.abe/abe.*.env)',
        'Edit(//home/kim/src/shop/.claude/worktrees/*/.abe/settings.local.yaml)',
        'Edit(//home/kim/src/shop/.claude/worktrees/*/.abe/abe.*.env)',
        'Edit(//home/kim/src/shop/.git/config)',
        'Edit(//home/kim/src/shop/.git/hooks/**)',
        'Edit(//home/kim/src/shop/.git/worktrees/*/config.worktree)',
        'Edit(//home/kim/src/shop/.git/worktrees/*/commondir)',
        'Edit(//home/kim/src/shop/.git/worktrees/*/gitdir)',
        'Edit(//home/kim/src/shop-wt/*/.git)',
        'Edit(//home/kim/src/shop/.claude/worktrees/*/.git)',
        'Edit(//home/kim/src/shop/.git/config.worktree)',
        'Edit(//home/kim/src/shop/.git/commondir)',
        'Edit(//home/kim/src/shop/.git/modules/**/config)',
        'Edit(//home/kim/src/shop/.git/modules/**/config.worktree)',
        'Edit(//home/kim/src/shop/.git/modules/**/commondir)',
        'Edit(//home/kim/src/shop/.git/modules/**/hooks/**)',
        'Edit(//home/kim/src/shop/.claude/worktrees/*/**/.claude/**)',
        'Edit(//home/kim/src/shop/.claude/worktrees/*/**/.mcp.json)',
        // Claude Code's project settings in its worktree: no hook or allow rule the agent adds.
        'Edit(**/.claude/settings.json)',
        'Edit(**/.claude/settings.local.json)',
        // Agents never merge, nor write a branch through GitHub's API (#196).
        ...MERGE_DENY,
        // Nor turn the pre-push hook off: git's config on its command line or in its environment
        // (any case), `--no-verify` however short.
        // (`-c` after a command's name is its own: `git grep -c`.)
        'Bash(git -c *)',
        'Bash(git * -c *=*)',
        'Bash(git *--config-env*)',
        'Bash(*GIT_CONFIG*)',
        'Bash(git *hooksPath*)',
        'Bash(git *hookspath*)',
        'Bash(git *--no-v*)',
        // A push to main or master named on the line (from the main checkout too, whose own hooks
        // let it through), and any push run in the main checkout.
        // (`git push`, or after `-C <dir>`: a commit message saying "push to main" is no push.)
        ...['git push', 'git -C * push'].flatMap((push) =>
          ['main', 'master'].flatMap((branch) => [
            `Bash(${push}* ${branch})`,
            `Bash(${push}* ${branch} *)`,
            `Bash(${push}*:${branch})`,
            `Bash(${push}*:${branch} *)`,
            `Bash(${push}*:refs/heads/${branch}*)`,
          ]),
        ),
        'Bash(git -C /home/kim/src/shop push*)',
        'Bash(git -C /home/kim/src/shop/ push*)',
        // A backstop should a fenced tool's hook never answer (Claude Code's timeout lets it go):
        // where a write runs as the person later.
        'Edit(//home/kim/.zshrc)',
        'Edit(//home/kim/.zprofile)',
        'Edit(//home/kim/.zshenv)',
        'Edit(//home/kim/.bashrc)',
        'Edit(//home/kim/.bash_profile)',
        'Edit(//home/kim/.profile)',
        'Edit(//home/kim/.gitconfig)',
        'Edit(//home/kim/.config/git/**)',
        'Edit(//home/kim/.ssh/**)',
        'Edit(//home/kim/Library/LaunchAgents/**)',
      ],
    });
  });

  test('MERGE_DENY: a merge, auto-merge, an alias and a branch written through the API (#196)', () => {
    expect([...MERGE_DENY]).toEqual([
      'Bash(gh pr merge:*)',
      'Bash(gh api *pulls/*/merge*)',
      'Bash(gh api *merges*)',
      'Bash(gh api *mergePullRequest*)',
      'Bash(gh api *AutoMerge*)',
      'Bash(gh api *git/refs*)',
      'Bash(gh api *updateRef*)',
      'Bash(gh api *contents/*)',
      'Bash(gh api *createCommitOnBranch*)',
      'Bash(gh api *mergeBranch*)',
      'Bash(gh alias*)',
      // Nor gh's token handed to another client (curl reaches api.github.com too).
      'Bash(gh auth token*)',
      // Nor a protection, ruleset or default branch changed, nor a request read from a file,
      // whose words no rule sees (#181 review).
      'Bash(gh api *protection*)',
      'Bash(gh api *rulesets*)',
      'Bash(gh api *BranchProtection*)',
      'Bash(gh api *default_branch*)',
      'Bash(gh api *=@*)',
      'Bash(gh api *--input*)',
      'Bash(gh repo edit*)',
    ]);
  });

  test("withWorktreeHeld: the worktree the runner put it in held by name, a person's elsewhere too", () => {
    const settings = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: [],
      boundary: sessionBoundary({ ...at, worktree: '/home/kim/src/shop-wt/4-checkout' }),
      skillsOnTop: false,
      home: '/home/kim',
    });
    const elsewhere = withWorktreeHeld(settings, '/home/kim/work/checkout');
    const same = withWorktreeHeld(settings, '/home/kim/src/shop-wt/4-checkout');

    expect(elsewhere.sandbox?.filesystem?.denyWrite?.slice(-1)).toEqual([
      // your own settings there: its reach (ADR 0029); its .git and Claude Code's config written
      '/home/kim/work/checkout/.abe/settings.local.yaml',
    ]);
    expect(elsewhere.permissions?.deny).toEqual(
      [...(settings.permissions?.deny ?? [])].concat([
        'Edit(//home/kim/work/checkout/.git)',
        'Edit(//home/kim/work/checkout/**/.claude/**)',
        'Edit(//home/kim/work/checkout/**/.mcp.json)',
        'Edit(//home/kim/work/checkout/.abe/settings.local.yaml)',
      ]),
    );
    expect(same).toEqual(settings);
    // An install in its main checkout: held by the boundary already.
    expect(withWorktreeHeld(settings, at.checkout)).toEqual(settings);
    // A box's session has no sandbox of ours: nothing added.
    const box = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: [],
      skillsOnTop: false,
      home: '/home/kim',
    });

    expect(withWorktreeHeld(box, '/w')).toEqual(box);
  });

  test("a card's session: its worktree's and Before's .git denied by name to the file tools, your settings and env files there to all (#181, #182)", () => {
    const b = sessionBoundary({ ...at, worktree: '/home/kim/src/shop-wt/4-checkout' });

    for (const tree of ['4-checkout', '4-checkout-base']) {
      for (const held of ['.abe/settings.local.yaml', '.abe/abe.*.env']) {
        expect(b.sandbox.filesystem.denyWrite).toContain(`/home/kim/src/shop-wt/${tree}/${held}`);
        expect(b.deny).toContain(`Edit(//home/kim/src/shop-wt/${tree}/${held})`);
      }
      // the repo's settings in a worktree are the card's to change: the checkout's decide
      expect(b.sandbox.filesystem.denyWrite).not.toContain(
        `/home/kim/src/shop-wt/${tree}/abe.yaml`,
      );
      expect(b.deny).toContain(`Edit(//home/kim/src/shop-wt/${tree}/.git)`);
      expect(b.deny).toContain(`Edit(//home/kim/src/shop-wt/${tree}/**/.claude/**)`);
    }
    // its git is its shell's to write but the config and hooks serve's git runs (ADR 0029)
    expect(b.sandbox.filesystem.denyWrite.filter((p) => p.includes('.git'))).toEqual([
      '/home/kim/src/shop/.git/config',
      '/home/kim/src/shop/.git/hooks',
      '/home/kim/src/shop/.git/config.worktree',
      '/home/kim/src/shop/.git/worktrees/*/config.worktree',
    ]);
    expect(b.sandbox.filesystem.denyWrite.filter((p) => p.includes('.claude/'))).toEqual([
      '/home/kim/src/shop/.claude/worktrees/*/.abe/settings.local.yaml',
      '/home/kim/src/shop/.claude/worktrees/*/.abe/abe.*.env',
    ]);
  });

  test('your own Layer folder never written', () => {
    const b = sessionBoundary({ ...at, config: '/home/kim/.config/abe' });

    expect(b.sandbox.filesystem.denyWrite).toContain('/home/kim/.config/abe');
    expect(b.deny).toContain('Edit(//home/kim/.config/abe/**)');
  });

  test('a local session keeps no auto memory: Claude Code would write it outside the worktree, past the fence (#181)', () => {
    const settings = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: [],
      boundary: sessionBoundary(at),
      skillsOnTop: false,
      home: '/home/kim',
    });
    const box = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: [],
      skillsOnTop: false,
      home: '/home/kim',
    });

    expect(settings.autoMemoryEnabled).toBe(false);
    expect(box.autoMemoryEnabled).toBeUndefined();
  });

  test('an own state folder: the default state hidden too, read and written alike', () => {
    const own = {
      ...at,
      state: '/home/kim/abe-qa/state',
      serveSocket: '/home/kim/abe-qa/state/serve.sock',
      defaultStates: [at.state],
    };
    const b = sessionBoundary(own);

    expect(b.sandbox.filesystem.denyRead).toEqual([own.state, at.state]);
    expect(b.sandbox.filesystem.denyWrite).toContain(at.state);
    expect(b.deny).toContain(`Read(/${at.state}/**)`);
    expect(b.deny).toContain(`Edit(/${at.state}/**)`);
  });

  test("serve's tmux server is out of reach: its socket hidden, never an allowed one, its files denied", () => {
    const tmux = `${at.state}/tmux.sock`;
    const b = sessionBoundary(at);
    const under = (dirs: readonly string[]) => dirs.some((d) => tmux.startsWith(`${d}/`));

    expect(under(b.sandbox.filesystem.denyRead)).toBe(true);
    expect(under(b.sandbox.filesystem.allowRead)).toBe(false);
    expect(b.sandbox.network.allowUnixSockets).toEqual([at.socket]);
    expect(b.deny).toContain(`Read(/${at.state}/**)`);
    expect(b.deny).toContain(`Edit(/${at.state}/**)`);
  });

  test("serve's socket outside the state (ABE_SOCKET): denied by name too", () => {
    const b = sessionBoundary({ ...at, serveSocket: '/run/abe/serve.sock' });

    // never read, so never connected to either (`seatbeltProfile`)
    expect(b.sandbox.filesystem.denyRead).toEqual([at.state, '/run/abe/serve.sock']);
    expect(b.deny).toContain('Read(//run/abe/serve.sock)');
    expect(b.deny).toContain('Edit(//run/abe/serve.sock)');
  });

  test('sessionSettings carries the boundary: the sandbox, and its deny rules beside the allow rules', () => {
    const boundary = sessionBoundary(at);
    const settings = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: ['Bash(abe status:*)'],
      boundary,
      skillsOnTop: false,
      home: '/home/kim',
    });

    expect(settings.sandbox).toEqual(boundary.sandbox);
    expect(settings.permissions).toEqual({
      allow: ['Bash(abe status:*)'],
      deny: boundary.deny,
      additionalDirectories: boundary.directories,
    });
  });

  test("a Factory session's permission mode: auto, so it never waits on one", () => {
    const settings = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: [],
      boundary: sessionBoundary(at),
      skillsOnTop: false,
      home: '/home/kim',
      mode: FACTORY_PERMISSION_MODE,
    });

    expect(FACTORY_PERMISSION_MODE).toBe('auto');
    expect(settings.permissions?.defaultMode).toBe('auto');
    // Its sandboxed commands (compound lines too) run without asking; the deny rules still hold.
    expect(settings.sandbox?.autoAllowBashIfSandboxed).toBe(true);
    expect(settings.permissions?.deny).toEqual(sessionBoundary(at).deny);
  });

  test('a session that is no Factory run keeps the mode the person gave Claude Code', () => {
    const settings = sessionSettings({
      abe: 'abe',
      models: { coordinator: 'opus', reader: 'sonnet', writer: 'opus' },
      allowedModels: ['opus'],
      allow: [],
      skillsOnTop: false,
      home: '/home/kim',
    });

    expect(settings.permissions).not.toHaveProperty('defaultMode');
  });
});

describe('abe session send says where the message is (#197)', () => {
  test.each([
    [{ queued: null }, 'sent to 4-ab\n'],
    [
      { queued: 1, held: 'starting' as const },
      'held as 1 for 4-ab: its claude has not started yet; typed in once it runs\n',
    ],
    [
      { queued: 2, held: 'dialog' as const },
      'held as 2 for 4-ab: a permission prompt waits for your answer; typed in once it is answered\n',
    ],
    [
      { queued: 4, held: 'question' as const },
      'held as 4 for 4-ab: a question card waits for your answer; it goes with the answer\n',
    ],
    [{ queued: 3 }, 'held as 3 for 4-ab: typed in after the messages held before it\n'],
  ])('%o', (at, text) => {
    expect(sessionSendText({ id: '4-ab', sent: 'x', ...at })).toBe(text);
  });

  test('abe session stop says it stopped in one line, never the session-show block', () => {
    const s = {
      v: 1,
      id: '4-ab12',
      card: 4,
      title: 'Sign in',
      repo: '/r/demo',
      worktree: '/r/demo/wt',
      branch: 'card/4-sign-in',
      state: 'ended',
      since: '2026-10-24T10:00:00.000Z',
      startedAt: '2026-10-24T10:00:00.000Z',
      transcriptPath: null,
      lastAssistantMessage: null,
      claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
      socket: '/s/4-ab12/session.sock',
      stopped: true,
    };

    expect(sessionStopText(SessionData.parse(s))).toBe(
      'stopped 4-ab12  AB#4: its worktree and branch card/4-sign-in stay\n',
    );
    expect(sessionStopText(SessionData.parse({ ...s, box: 'demo-shop' }))).toBe(
      'stopped 4-ab12  AB#4: its worktree and branch card/4-sign-in stay on demo-shop\n',
    );
  });

  test("abe session list's rows name their repo once the sessions span more than one", () => {
    const s = {
      v: 1,
      id: '7-a1',
      card: 7,
      title: 'Cart',
      repo: '/r/shop',
      worktree: '/r/shop-wt/7',
      branch: 'card/7-cart',
      state: 'working',
      since: '2026-10-24T10:00:00.000Z',
      startedAt: '2026-10-24T10:00:00.000Z',
      transcriptPath: null,
      lastAssistantMessage: null,
      claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
      socket: '/s/7-a1/session.sock',
    };
    const a = SessionData.parse(s);
    const b = SessionData.parse({ ...s, id: '7-b1', repo: '/r/shop-b/' });
    const c = SessionData.parse({ ...s, id: '7-c1', repo: 'acme/shop', box: 'demo-shop' });
    const rows = (...sessions: SessionData[]) =>
      sessionListText({ sessions }, { now: Date.parse(s.since) })
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.split('  ').slice(0, 2).join('  '));

    expect(rows(a, { ...a, id: '7-a2' })).toEqual(['7-a1  AB#7', '7-a2  AB#7']);
    expect(rows(a, b, c)).toEqual([
      '7-a1  AB#7 in shop',
      '7-b1  AB#7 in shop-b',
      '7-c1  AB#7 in acme/shop',
    ]);
  });
});

describe("a session's kind is derived from what it is on, never read from the file (#213 D2)", () => {
  // A meta.json as serve wrote it before `kind` was kept: no `kind` field.
  const OLD = {
    v: 1,
    id: '4-ab12',
    card: 4,
    title: 'Sign in',
    repo: '/r/demo',
    worktree: '/r/demo/wt',
    branch: 'card/4-sign-in',
    state: 'ended',
    since: '2026-10-24T10:00:00.000Z',
    startedAt: '2026-10-24T10:00:00.000Z',
    transcriptPath: null,
    lastAssistantMessage: null,
    claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
    socket: '/s/4-ab12/session.sock',
  };
  const prototype = { id: 'proto-1a2b3c', card: 4 };

  test.each([
    ['a card session', OLD, 'card'],
    ['a prototype with no card', { ...OLD, card: null, prototype }, 'prototype'],
    ["a card's prototype", { ...OLD, prototype }, 'prototype'],
    ['the Abe chat', { ...OLD, card: null, abe: { repo: '/r' } }, 'abe'],
    ['an Ask, a kind no more', { ...OLD, card: null, ask: { words: 'why?', about: null } }, 'card'],
  ] as const)('an old-shape meta.json of %s reads as %s', (_, doc, kind) => {
    expect(SessionMeta.parse(doc).kind).toBe(kind);
    expect(SessionData.parse(doc).kind).toBe(kind);
  });

  test('a stored kind that disagrees with its fields is not believed', () => {
    const stale = { ...OLD, prototype, kind: 'card' };

    expect(SessionMeta.parse(stale).kind).toBe('prototype');
    expect(SessionData.parse(stale).kind).toBe('prototype');
  });

  test('a record written now still names its kind, so an older reader keeps it', () => {
    const read = SessionMeta.parse({ ...OLD, card: null, abe: { repo: '/r' } });

    expect(JSON.parse(JSON.stringify(read))).toMatchObject({ kind: 'abe' });
  });

  test('an old network Override (ADR 0029: the network is open) is dropped, the others kept', () => {
    const at = '2026-10-24T10:00:00.000Z';
    const db = {
      what: 'db read test',
      words: 'Test DB read',
      area: { kind: 'reach', service: 'db', access: 'read', environment: 'test' },
      reason: 'seed',
      at,
    } as const;
    const network = {
      what: 'network api.stripe.com',
      words: 'Network api.stripe.com',
      area: { kind: 'network', host: 'api.stripe.com' },
      reason: 'docs',
      at,
    };

    expect(SessionMeta.parse({ ...OLD, overrides: [network, db] }).overrides).toEqual([db]);
    expect(SessionData.parse({ ...OLD, overrides: [network] }).overrides).toEqual([]);
  });

  test('withKind gives a new record its kind', () => {
    expect(withKind({ card: 4, prototype }).kind).toBe('prototype');
  });
});
