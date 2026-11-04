/**
 * Factory install's IO: `claude mcp get`'s status line read alone, a source's account asked through
 * a fake `claude -p`, this Mac's aws profiles through a fake `aws`, git's search of a checkout,
 * the exclude block kept whole.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type McpState,
  ORIGIN_AUTH_PATTERN,
  type SourceProbe,
  sourceAccountPrompt,
} from '@abe/core';
import { fakeClaude, type FakeClaude, oneShotCalls, scriptOneShot } from '@abe/testing';
import { excludeText, localInstallRepo, mcpStateOf } from './install-repo';

describe("mcpStateOf: Claude Code's status, nothing else of its answer", () => {
  test.each<[string, number, string, McpState]>([
    ['connected', 0, 'sentry:\n  Scope: User\n  Status: ✓ Connected\n  Type: http', 'connected'],
    ['needs its sign-in', 0, 'figma:\n  Status: ⚠ Needs authentication\n', 'needs-auth'],
    ['failing', 0, 'datadog:\n  Status: ✗ Failed to connect\n', 'failed'],
    ['none of yours', 1, 'No MCP server found with name: linear', 'none'],
    [
      "the repo's .mcp.json alone: none, it never loads in a session",
      0,
      'docs:\n  Scope: Project config (shared via .mcp.json)\n  Status: ✓ Connected\n',
      'none',
    ],
  ])('%s', (_, exit, out, want) => {
    expect(mcpStateOf(exit, out)).toBe(want);
  });
});

describe("sourceAccount: the probe, one server as a session in the checkout gets it, through the person's claude -p", () => {
  let claude: FakeClaude;
  const dirs: string[] = [];

  beforeAll(() => {
    claude = fakeClaude();
  });

  afterAll(() => {
    claude.remove();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const SERVERS = (name: string) => `{"mcpServers":{"${name}":{"type":"http"}}}`;
  const LOCAL = (name: string) => (top: string) =>
    JSON.stringify({ projects: { [top]: { mcpServers: { [name]: { type: 'http' } } } } });
  const NONE = { read: 'timeout', account: {} } as const;

  test.each<
    [
      string,
      {
        project?: string;
        personal?: string | ((top: string) => string);
        answers?: string[];
        exit?: number;
        sleep?: number;
        path?: string;
        name?: string;
        /** The repo's `sources:` (ADR 0031): a bare sentry by default. */
        sources?: string;
      },
      SourceProbe,
      boolean,
    ]
  >([
    [
      "your user scope names it, the project's .mcp.json too: yours, read ok",
      {
        project: SERVERS('sentry'),
        personal: SERVERS('sentry'),
        answers: ['{"read":"ok","org":"acme","project":"web"}'],
      },
      { read: 'ok', account: { org: 'acme', project: 'web' } },
      true,
    ],
    [
      "the checkout's local scope names it (ADR 0027): asked",
      { personal: LOCAL('sentry'), answers: ['{"read":"ok","account":"ann"}'] },
      { read: 'ok', account: { account: 'ann' } },
      true,
    ],
    [
      'the tool said an error: the account cannot read',
      { personal: SERVERS('sentry'), answers: ['{"read":"error","account":null}'] },
      { read: 'tool-error', account: {} },
      true,
    ],
    [
      "the project's .mcp.json alone: not asked, it never loads in a session",
      { project: SERVERS('sentry'), personal: SERVERS('figma') },
      NONE,
      false,
    ],
    ['neither names it: not asked', { personal: SERVERS('figma') }, NONE, false],
    [
      'sources: defines it (ADR 0031): its definition, though no scope of yours has it',
      {
        personal: SERVERS('figma'),
        sources: '[{ name: sentry, transport: http, url: "https://mcp.sentry.dev/mcp" }]',
        answers: ['{"read":"ok"}'],
      },
      { read: 'ok', account: {} },
      true,
    ],
    [
      "yours names it, sources: doesn't: not asked",
      { personal: SERVERS('sentry'), sources: '[figma]' },
      NONE,
      false,
    ],
    [
      'claude -p failed',
      { personal: SERVERS('sentry'), answers: ['Not logged in'], exit: 1 },
      { read: 'tool-error', account: {} },
      true,
    ],
    [
      'past its time',
      { personal: SERVERS('sentry'), answers: ['{"read":"ok"}'], sleep: 5000 },
      NONE,
      true,
    ],
    ['no claude on PATH', { personal: SERVERS('sentry'), path: '/usr/bin:/bin' }, NONE, false],
    ['a name no server has', { personal: SERVERS('sentry'), name: 'sentry;rm' }, NONE, false],
  ])('%s', async (_, o, want, asked) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'source-account-')));
    const top = join(home, 'repo');

    dirs.push(home);
    mkdirSync(join(top, '.abe'), { recursive: true });
    writeFileSync(join(top, 'abe.yaml'), `sources: ${o.sources ?? '[sentry]'}\n`);
    if (o.project !== undefined) writeFileSync(join(top, '.mcp.json'), o.project);
    if (o.personal !== undefined)
      writeFileSync(
        join(home, '.claude.json'),
        typeof o.personal === 'string' ? o.personal : o.personal(top),
      );
    scriptOneShot(home, { answers: o.answers ?? ['{}'], exit: o.exit ?? 0, sleep: o.sleep ?? 0 });
    const repo = localInstallRepo({
      env: { HOME: home, PATH: o.path ?? claude.path },
      accountMs: 1_000,
    });

    expect(await repo.sourceAccount(top, o.name ?? 'sentry', 'haiku')).toEqual(want);
    const calls = oneShotCalls(home);

    if (!asked) {
      expect(calls).toEqual([]);

      return;
    }
    const [call] = calls;
    const argv = call?.argv ?? [];
    const config = argv[argv.indexOf('--mcp-config') + 1] ?? '';

    // a generated config of that one server, gone once asked: never the person's own file
    expect([config.endsWith('/mcp.json'), config.startsWith(home), existsSync(config)]).toEqual([
      true,
      false,
      false,
    ]);
    expect([argv.slice(0, 5), call?.cwd, call?.prompt]).toEqual([
      ['-p', '--model', 'haiku', '--tools', ''],
      top,
      sourceAccountPrompt('sentry'),
    ]);
  });
});

describe("awsProfiles: this Mac's aws profiles, by name only", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test.each<[string, { out: string; exit: number } | null, string[]]>([
    [
      'its names, one a line',
      { out: 'default\ndev\nshop-test\n', exit: 0 },
      ['default', 'dev', 'shop-test'],
    ],
    ['a line that is no name is never said', { out: 'dev\nkey = AKIA x\n\n', exit: 0 }, ['dev']],
    ['aws failed', { out: 'dev\n', exit: 1 }, []],
    ['no aws on PATH', null, []],
  ])('%s', async (_, aws, want) => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'aws-profiles-')));

    dirs.push(bin);
    if (aws !== null)
      writeFileSync(
        join(bin, 'aws'),
        `#!/bin/sh\n[ "$1 $2" = "configure list-profiles" ] || exit 2\nprintf '${aws.out}'\nexit ${aws.exit}\n`,
        { mode: 0o755 },
      );
    const repo = localInstallRepo({ env: { HOME: bin, PATH: bin } });

    expect(await repo.awsProfiles()).toEqual(want);
  });
});

describe('grep: the lines of the files git tracks, at most max', () => {
  let top: string;
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', ...args], {
      cwd: top,
      env: { PATH: '/usr/bin:/bin', HOME: top, GIT_CONFIG_NOSYSTEM: '1' },
    });

  beforeAll(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'install-grep-')));
    git('init', '-q');
    mkdirSync(join(top, 'web', 'src'), { recursive: true });
    writeFileSync(
      join(top, 'web', 'src', 'auth.ts'),
      'a\n  redirect_uri: window.location.origin,\n',
    );
    writeFileSync(join(top, 'web', 'src', 'b.ts'), 'REDIRECTURI = location.origin\n');
    writeFileSync(join(top, 'untracked.ts'), 'redirect_uri: location.origin\n');
    git('add', 'web');
  });
  afterAll(() => {
    rmSync(top, { recursive: true, force: true });
  });

  test.each<[string, string, number, [string, number, string][]]>([
    [
      'each line, any case, untracked files never',
      ORIGIN_AUTH_PATTERN,
      10,
      [
        ['web/src/auth.ts', 2, '  redirect_uri: window.location.origin,'],
        ['web/src/b.ts', 1, 'REDIRECTURI = location.origin'],
      ],
    ],
    [
      'at most max',
      ORIGIN_AUTH_PATTERN,
      1,
      [['web/src/auth.ts', 2, '  redirect_uri: window.location.origin,']],
    ],
    ['none found', 'nothing-like-this', 10, []],
  ])('%s', async (_, pattern, max, want) => {
    const lines = await localInstallRepo({ env: { HOME: top, PATH: '/usr/bin:/bin' } }).grep(
      top,
      pattern,
      max,
    );

    expect(lines.map((l) => [l.path, l.line, l.text])).toEqual(want);
  });
});

describe('runChecks: each command once on a clean tree of HEAD, outside the working tree', () => {
  let top: string;
  let bare: string;
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
    });
  const env = { HOME: '/nowhere', PATH: '/usr/bin:/bin', SECRET_TOKEN: 'hunter2' };

  beforeAll(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'install-checks-')));
    bare = realpathSync(mkdtempSync(join(tmpdir(), 'install-checks-bare-')));
    git(top, 'init', '-q');
    git(bare, 'init', '-q');
    writeFileSync(join(top, 'a.txt'), 'good\n');
    git(top, 'add', 'a.txt');
    git(top, 'commit', '-q', '-m', 'one');
    // after HEAD: the working tree edited, a file untracked
    writeFileSync(join(top, 'a.txt'), 'edited\n');
    writeFileSync(join(top, 'untracked.txt'), 'x\n');
  });
  afterAll(() => {
    rmSync(top, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  test.each<[string, string, string, { ok: boolean; says: string } | undefined]>([
    ['HEAD’s text, not the working tree’s', 'top', 'grep -qx good a.txt', { ok: true, says: '' }],
    ['an untracked file is not there', 'top', 'test ! -e untracked.txt', { ok: true, says: '' }],
    ['git knows the files', 'top', 'git ls-files | grep -qx a.txt', { ok: true, says: '' }],
    ['none of the person’s environment', 'top', 'test -z "$SECRET_TOKEN"', { ok: true, says: '' }],
    [
      'a failing one says what it printed',
      'top',
      'echo broken >&2; exit 3',
      { ok: false, says: 'broken' },
    ],
    ['no commit yet: no clean tree', 'bare', 'true', undefined],
  ])('%s', async (_, where, command, want) => {
    const repo = localInstallRepo({ env });
    const ran = await repo.runChecks(where === 'top' ? top : bare, [command]);

    expect(ran === undefined ? undefined : ran[0]).toEqual(want);
  });

  test('one answer per command, in order, and the working tree left as it was', async () => {
    const ran = await localInstallRepo({ env }).runChecks(top, ['true', 'false', 'true']);

    expect(ran?.map((r) => r.ok)).toEqual([true, false, true]);
    expect(Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: top }).stdout.toString()).toBe(
      ' M a.txt\n?? untracked.txt\n',
    );
  });
});

describe("excludeText: the install's block, the rest kept", () => {
  const BLOCK = '# abe install: kept out of git\n.abe/\nAGENTS.md\n# abe install: end\n';
  const CARD = '# abe: card worktrees (kept out of git)\n.scratch/\n# abe: card worktrees end\n';

  test.each<[string, string, string[], string]>([
    [
      'into git’s own',
      '# git ls-files --others\n*.log\n',
      ['.abe/', 'AGENTS.md'],
      `# git ls-files --others\n*.log\n${BLOCK}`,
    ],
    ['into none', '', ['.abe/', 'AGENTS.md'], BLOCK],
    ['written again: once', BLOCK, ['.abe/', 'AGENTS.md'], BLOCK],
    ['taken out', `*.log\n${BLOCK}`, [], '*.log\n'],
    ["a card worktree's block left as it is", `${CARD}${BLOCK}`, [], CARD],
    [
      "an earlier Abe's block: the install's, written anew",
      `*.log\n${BLOCK.replace('kept out of git', 'Just this Mac (kept out of git)')}`,
      ['.abe/', 'AGENTS.md'],
      `*.log\n${BLOCK}`,
    ],
  ])('%s', (_, text, paths, want) => {
    expect(excludeText(text, paths)).toBe(want);
  });
});
