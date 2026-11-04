/** Rule tables for what agents reach (ADR 0029): the enabled environments, in full; no other. */
import { describe, expect, test } from 'bun:test';
import {
  accessRules,
  type AbeEnv,
  agentEnvsLine,
  BOX_TREES,
  envPlacement,
  offRepoEnvFiles,
  SECRET_OUTPUT_DENY,
} from '../index';

describe('the repo env files no session reads: those feeding only environments off, and not sure', () => {
  test.each<[string, AbeEnv[], string[]]>([
    ['prod off', ['dev', 'test'], ['.env.production', 'old/.env']],
    ['prod on: only the unplaced one', ['dev', 'test', 'prod'], ['old/.env']],
    ['test off too', ['dev'], ['.env.production', '.env.test', 'old/.env']],
  ])('%s', (_, enabled, want) => {
    expect(
      offRepoEnvFiles(
        [
          { path: '.env', to: ['dev', 'test', 'prod'] },
          { path: '.env.production', to: ['prod'] },
          { path: '.env.test', to: ['test'] },
          { path: '.env.example', to: 'not-used' },
          { path: 'old/.env', to: 'not-sure' },
        ],
        enabled,
      ),
    ).toEqual(want);
  });

  // abe.yaml's groups place a file first (ADR 0040): the record's mapping only for the rest
  test.each<[string, AbeEnv[], string[]]>([
    ['prod off: its group held, all never', ['dev', 'test'], ['backend/.env.prod', 'old/.env']],
    ['prod on: only the unplaced one', ['dev', 'test', 'prod'], ['old/.env']],
    [
      'every environment off: all still every run',
      [],
      ['backend/.env.dev', 'backend/.env.prod', 'old/.env'],
    ],
  ])('from abe.yaml groups, %s', (_, enabled, want) => {
    const placed = envPlacement(
      {
        link: { all: ['frontend/.env'], dev: ['backend/.env.dev'], prod: ['backend/.env.prod'] },
      },
      [
        // the record says otherwise: the group wins
        { path: 'backend/.env.prod', to: ['dev'] },
        { path: 'old/.env', to: 'not-sure' },
      ],
      [{ key: 'backend/.env.old' }],
    );

    expect(offRepoEnvFiles(placed, enabled)).toEqual(want);
  });
});

/**
 * Claude Code's permission rule format (code.claude.com/docs/en/permissions): `Tool` or
 * `Tool(content)`, parentheses balanced; `:*` only at the end; an MCP rule without parentheses and,
 * when it allows, no wildcard in its server; an allow Bash rule with no `*` before its command.
 * Any other is skipped with a warning at start.
 */
const ruleProblem = (rule: string, kind: 'allow' | 'deny'): string | undefined => {
  const m = /^([A-Za-z][A-Za-z0-9_*-]*)(?:\((.*)\))?$/s.exec(rule);

  if (m === null) return 'malformed';
  const [, tool = '', content] = m;

  if (content === '') return 'empty content';
  if (tool.startsWith('mcp__')) {
    if (content !== undefined) return 'an mcp rule with parentheses';
    if (kind === 'allow' && (tool.split('__')[1] ?? '').includes('*')) return 'a wildcard server';

    return undefined;
  }
  if (content?.includes(':*') === true && !content.endsWith(':*')) return ':* not at the end';
  if (kind === 'allow' && tool === 'Bash' && content?.startsWith('*') === true)
    return 'a wildcard before the command';
  // Claude Code warns a Write rule never matches: Edit holds every file tool that writes
  if (tool === 'Write') return 'a Write rule, never matched';
  if ((tool === 'Read' || tool === 'Edit') && content?.startsWith('//') !== true)
    return 'a path not from /';

  return undefined;
};

describe("a session's access rules: every source's tools allowed; only the off environments' files and secret output denied", () => {
  const trees = ['/r/shop', '/r/shop-wt/4-cart'];

  test.each<[string, readonly string[], AbeEnv[], string[]]>([
    [
      'sources, prod off: its file denied in the checkout and the worktree',
      ['sentry', 'figma'],
      ['dev', 'test'],
      ['/r/shop/.abe/abe.prod.env', '/r/shop-wt/4-cart/.abe/abe.prod.env'],
    ],
    [
      'a source with a dot, test off too',
      ['my.server'],
      ['dev'],
      [
        '/r/shop/.abe/abe.test.env',
        '/r/shop/.abe/abe.prod.env',
        '/r/shop-wt/4-cart/.abe/abe.test.env',
        '/r/shop-wt/4-cart/.abe/abe.prod.env',
      ],
    ],
    ['every one on: nothing of them denied', [], ['dev', 'test', 'prod'], []],
  ])('%s', (_, servers, enabled, files) => {
    const rules = accessRules({ servers, enabled, trees });

    // every tool of every added server, writes too
    expect(rules.allow).toEqual(servers.map((s) => `mcp__${s.replace('.', '_')}__*`));
    expect(rules.deny).toEqual([
      ...files.flatMap((f) => [`Read(/${f})`, `Edit(/${f})`]),
      ...SECRET_OUTPUT_DENY,
    ]);
    expect(rules.denyRead).toEqual(files);
    // Claude Code starts with every rule: none it would skip with a warning
    expect([
      ...rules.allow.flatMap((r) => ruleProblem(r, 'allow') ?? []),
      ...rules.deny.flatMap((r) => ruleProblem(r, 'deny') ?? []),
    ]).toEqual([]);
  });
});

describe("a session never reads another checkout's Abe env files, nor its own repo's off-env files", () => {
  test('repo files in both trees, every Abe env file of another checkout', () => {
    const rules = accessRules({
      servers: [],
      enabled: ['dev', 'test', 'prod'],
      trees: ['/r/shop', '/r/shop-wt/4'],
      repoFiles: ['.env.production'],
      others: ['/r/shop', '/r/blog'],
    });

    expect(rules.denyRead).toEqual([
      '/r/shop/.env.production',
      '/r/shop-wt/4/.env.production',
      '/r/blog/.abe/abe.dev.env',
      '/r/blog/.abe/abe.test.env',
      '/r/blog/.abe/abe.prod.env',
    ]);
  });
});

describe("a box session's rules on its container's paths: the box's checkout is not there", () => {
  test("off env files and repo files in the clone and Before's worktree, no other checkout", () => {
    const rules = accessRules({
      servers: [],
      enabled: ['dev', 'test'],
      trees: BOX_TREES,
      repoFiles: ['.env.production'],
    });

    expect(rules.denyRead).toEqual([
      '/workspace/repo/.abe/abe.prod.env',
      '/workspace/repo/.env.production',
      '/workspace/repo-base/.abe/abe.prod.env',
      '/workspace/repo-base/.env.production',
    ]);
    for (const tool of ['Read', 'Edit'])
      expect(rules.deny).toContain(`${tool}(//workspace/repo/.abe/abe.prod.env)`);
    expect(rules.deny.join(' ')).not.toContain('/home/');
  });
});

describe('a session is told which environments it reaches, and that the others are out by design', () => {
  test.each<[AbeEnv[], string]>([
    [
      ['dev', 'test'],
      "Environments: this session reaches dev and test, read and write. aws only through abe run and the checks, with an enabled environment's short-lived keys: no profile of ~/.aws is reached here. prod is off for agents in this repo and unreachable by design (no env file, no aws keys, no secret of its systems): never look for a way around. Say what needs it; the person runs it, or turns it on for a next session.",
    ],
    [
      ['dev', 'test', 'prod'],
      "Environments: this session reaches dev and test and prod, read and write. aws only through abe run and the checks, with an enabled environment's short-lived keys: no profile of ~/.aws is reached here.",
    ],
  ])('%p', (enabled, want) => {
    expect(agentEnvsLine(enabled)).toBe(want);
  });
});
