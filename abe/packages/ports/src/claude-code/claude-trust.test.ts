/**
 * Folder trust in Claude Code's config, and the local runner using it: a worktree Abe makes is
 * trusted before `claude` starts (the fake `claude` asks, as Claude Code does, for a folder its
 * config does not trust); a worktree the person made elsewhere on the branch is left to them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hookSettings, type SessionMcp } from '@abe/core';
import { claudeOutput, fakeClaude, type FakeClaude, killTmux, tmuxPath, until } from '@abe/testing';
import { claudeConfigFile, personalMcpConfig, trustFolder } from './claude-trust';
import { tmuxRunner } from '../mac/tmux';

const read = (home: string): unknown => JSON.parse(readFileSync(claudeConfigFile(home), 'utf8'));

describe('trustFolder', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'trust-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('sets the folder trusted, by the path given and its real path, keeping every other key', () => {
    const real = join(home, 'real');
    const link = join(home, 'link');

    mkdirSync(real);
    symlinkSync(real, link);
    writeFileSync(
      claudeConfigFile(home),
      JSON.stringify({
        numStartups: 3,
        projects: { [link]: { allowedTools: ['Bash'] }, '/other': { lastCost: 1 } },
      }),
    );

    expect(trustFolder(home, link)).toEqual({ ok: true, written: true });
    expect(read(home)).toEqual({
      numStartups: 3,
      projects: {
        [link]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
        [realpathSync(real)]: { hasTrustDialogAccepted: true },
        '/other': { lastCost: 1 },
      },
    });
  });

  test('again: nothing written', () => {
    expect(trustFolder(home, join(home, 'link'))).toEqual({ ok: true, written: false });
  });

  test('no config yet: one with only that trust', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'trust-'));

    try {
      expect(trustFolder(fresh, '/nowhere/x')).toEqual({ ok: true, written: true });
      expect(read(fresh)).toEqual({ projects: { '/nowhere/x': { hasTrustDialogAccepted: true } } });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('a config that is not JSON is never overwritten', () => {
    const broken = mkdtempSync(join(tmpdir(), 'trust-'));

    try {
      writeFileSync(claudeConfigFile(broken), '{ half');
      expect(trustFolder(broken, '/x').ok).toBe(false);
      expect(readFileSync(claudeConfigFile(broken), 'utf8')).toBe('{ half');
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

describe("personalMcpConfig: the person's ~/.claude.json, where it names MCP servers", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'mcp-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test.each<[string, string | null]>([
    ['no config', null],
    ['not JSON', '{ nope'],
    ['no mcpServers (Claude Code refuses such an --mcp-config)', '{"projects":{}}'],
    ['an empty mcpServers', '{"mcpServers":{}}'],
    ['mcpServers not an object', '{"mcpServers":[]}'],
  ])('%s: none', (_, text) => {
    rmSync(claudeConfigFile(home), { force: true });
    if (text !== null) writeFileSync(claudeConfigFile(home), text);

    expect(personalMcpConfig(home)).toBeUndefined();
  });

  test('servers named: the file itself, never a copy (their env may hold tokens)', () => {
    writeFileSync(
      claudeConfigFile(home),
      '{"projects":{},"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}',
    );

    expect(personalMcpConfig(home)).toBe(claudeConfigFile(home));
  });
});

describe("the local runner and Claude Code's trust dialog", () => {
  let root: string;
  let repo: string;
  let state: string;
  let claude: FakeClaude;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'run-')));
    repo = join(root, 'demo');
    state = join(root, 's');
    claude = fakeClaude();
    mkdirSync(repo);
    mkdirSync(state);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
  });
  afterAll(async () => {
    await killTmux(state);
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  const launched = async (
    id: string,
    branch: string,
    mcpMode: SessionMcp = 'yours',
    sources?: string[],
  ) => {
    const runner = tmuxRunner({
      stateDir: state,
      tmux: tmuxPath(),
      env: { HOME: state, PATH: '/usr/bin:/bin' },
      self: ['/usr/bin/true'],
      plugins: join(state, 'plugins'),
    });
    // what serve hands the runner (ADR 0027): the servers it found for the repo's sources
    const found =
      sources === undefined ? undefined : runner.sourceServers?.({ repo, sources, home: state });
    const out = await runner.launch({
      id,
      repo,
      branch,
      claudeSession: crypto.randomUUID(),
      prompt: 'hi',
      instructions: '',
      setup: null,
      plugin: [],
      skillsOnTop: false,
      mcpMode,
      ...(sources === undefined
        ? {}
        : {
            sources: {
              names: sources,
              local: false,
              servers: found?.servers ?? {},
              missing: found?.missing ?? [],
            },
          }),
      settings: hookSettings('/usr/bin/true'),
      env: { HOME: state, PATH: claude.path, TERM: 'xterm-256color' },
    });

    if (!out.ok) throw new Error(out.error.message);

    return out.data;
  };
  const launch = async (id: string, branch: string, mcpMode: SessionMcp = 'yours') =>
    (await launched(id, branch, mcpMode)).worktree;

  /** What the fake wrote about trust, once it started. */
  const trust = (worktree: string) =>
    until('the fake to say whether it asked for trust', () => claudeOutput(worktree).trust);

  test('a worktree Abe makes: trusted first, so claude never asks', async () => {
    const worktree = await launch('1-aaaa', 'card/1-new');

    expect(worktree).toBe(join(root, 'demo-wt', '1-new'));
    expect(await trust(worktree)).toEqual({ asked: false });
  });

  test('a worktree the person made elsewhere on the branch: left to them, claude asks', async () => {
    const theirs = join(root, 'mine');

    git(repo, 'worktree', 'add', '-q', '-b', 'card/2-theirs', theirs);
    const worktree = await launch('2-bbbb', 'card/2-theirs');

    expect(worktree).toBe(theirs);
    expect(await trust(worktree)).toEqual({ asked: true });
    expect(JSON.stringify(read(state))).not.toContain(theirs);
  });

  describe('session.mcp', () => {
    const argvOf = async (worktree: string) =>
      z.array(z.string()).parse(await until('claude started', () => claudeOutput(worktree).argv));

    const entry = (worktree: string): unknown =>
      z.object({ projects: z.record(z.string(), z.unknown()) }).parse(read(state)).projects[
        worktree
      ];

    beforeAll(() => {
      const config: unknown = existsSync(claudeConfigFile(state)) ? read(state) : {};

      // The repo's .mcp.json, one server of which the person approved in the checkout.
      writeFileSync(
        join(repo, '.mcp.json'),
        JSON.stringify({
          mcpServers: { docs: { command: 'docs-mcp' }, db: { command: 'db-mcp' } },
        }),
      );
      git(repo, 'add', '.mcp.json');
      git(repo, 'commit', '-q', '-m', 'mcp');
      writeFileSync(
        claudeConfigFile(state),
        JSON.stringify({
          ...(typeof config === 'object' ? config : {}),
          mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
          projects: {
            ...z
              .object({ projects: z.record(z.string(), z.unknown()) })
              .partial()
              .parse(config).projects,
            [repo]: { enabledMcpjsonServers: ['docs'], disabledMcpjsonServers: [] },
          },
        }),
      );
    });

    test("yours: the person's servers from their ~/.claude.json, not strict, so their claude.ai connectors load", async () => {
      const argv = await argvOf(await launch('3-cccc', 'card/3-yours'));

      expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(claudeConfigFile(state));
      expect(argv).not.toContain('--strict-mcp-config');
    });

    test("yours: the repo's .mcp.json servers rejected in its settings, though the person approved docs in the checkout; the worktree only trusted", async () => {
      const worktree = await launch('5-eeee', 'card/5-approvals');
      const argv = await argvOf(worktree);
      const settings = z
        .looseObject({
          enableAllProjectMcpServers: z.boolean().optional(),
          disabledMcpjsonServers: z.array(z.string()).optional(),
        })
        .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));

      expect([settings.enableAllProjectMcpServers, settings.disabledMcpjsonServers]).toEqual([
        false,
        ['docs', 'db'],
      ]);
      expect(entry(worktree)).toEqual({ hasTrustDialogAccepted: true });
    });

    test("abe-only: strict, and none of the person's servers", async () => {
      const argv = await argvOf(await launch('4-dddd', 'card/4-abe', 'abe-only'));

      expect(argv).toContain('--strict-mcp-config');
      expect(argv).not.toContain('--mcp-config');
    });

    // A Factory run's sources (ADR 0027): the servers found, in the config Abe generates; only
    // they and Abe's start.
    test.each<{
      name: string;
      id: string;
      sources: string[];
      files: () => string[];
      allowed: { serverName: string }[] | undefined;
      missing: string[];
    }>([
      {
        name: "linear from the person's config; docs, in the repo's .mcp.json alone, never loads",
        id: '6-ffff',
        sources: ['linear', 'docs', 'figma'],
        files: () => [join(state, 'sources', '6-ffff.json')],
        allowed: [{ serverName: 'linear' }],
        missing: ['docs', 'figma'],
      },
      {
        name: 'linear alone: the .mcp.json naming none of them is not loaded',
        id: '7-aaab',
        sources: ['linear'],
        files: () => [join(state, 'sources', '7-aaab.json')],
        allowed: [{ serverName: 'linear' }],
        missing: [],
      },
      {
        name: 'figma, in no config: as with no sources, the session told',
        id: '8-aaac',
        sources: ['figma'],
        files: () => [],
        allowed: undefined,
        missing: ['figma'],
      },
    ])('abe-only with sources: $name', async ({ id, sources, files, allowed, missing }) => {
      const data = await launched(id, `card/${id}`, 'abe-only', sources);
      const argv = await argvOf(data.worktree);
      const at = argv.indexOf('--mcp-config');
      const loaded = at === -1 ? [] : argv.slice(at + 1, argv.indexOf('--strict-mcp-config'));
      const settings = z
        .object({ allowedMcpServers: z.array(z.object({ serverName: z.string() })).optional() })
        .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));
      const told = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';

      expect(loaded).toEqual(files());
      expect(argv.filter((w) => w === '--strict-mcp-config')).toEqual(['--strict-mcp-config']);
      expect(settings.allowedMcpServers).toEqual(allowed);
      expect(data.sourcesMissing).toEqual(missing.length === 0 ? undefined : missing);
      expect(told.includes('not loaded in this session:')).toBe(missing.length > 0);
      // one line of them, whatever loaded
      expect(told.split('\n').filter((l) => l.startsWith('Sources:'))).toHaveLength(1);
      // The settings name servers only; the definitions are in the generated config alone.
      expect(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')).not.toContain(
        'mcp.linear.app',
      );
    });
  });
});
