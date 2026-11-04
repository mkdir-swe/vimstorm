/** The team's sources (ADR 0031) and the servers a session on this Mac launches with: one row per case. */
import { describe, expect, test } from 'bun:test';
import {
  claudeServers,
  repoSourcesOf,
  type SourceEntry,
  SourceEntries,
  sourceEntryOf,
  sourceServers,
  sourceServersConfig,
  sourcesTold,
  withSourceValues,
} from '../index';

const MAIN = '/home/me/work/shop';
const SENTRY = { type: 'http', url: 'https://mcp.sentry.dev/mcp' };
const FIGMA = { type: 'http', url: 'https://mcp.figma.com/mcp' };

const config = {
  mcpServers: { figma: FIGMA, other: { command: 'other-mcp' } },
  projects: {
    [MAIN]: {
      hasTrustDialogAccepted: true,
      mcpServers: {
        sentry: SENTRY,
        abe: { command: 'abe' },
        keyed: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer v' } },
        byVar: { type: 'http', url: 'https://y.test/mcp', headers: { 'X-Org': '${ORG}' } },
        stdio: { command: 'npx', args: ['some-mcp'], env: { TOKEN: 'v' } },
      },
    },
    '/home/me/work/other': { mcpServers: { linear: { type: 'http', url: 'https://l.test' } } },
  },
};

describe("sources: the team's MCP servers, never a secret", () => {
  test.each<[string, unknown, string | null]>([
    ['a remote one', [{ name: 'sentry', transport: 'http', url: SENTRY.url }], null],
    [
      'an sse one',
      [{ name: 'jira', transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse' }],
      null,
    ],
    ['a stdio one', [{ name: 'pg', transport: 'stdio', command: 'npx', args: ['pg-mcp'] }], null],
    [
      'a header by ${VAR}',
      [{ name: 'y', transport: 'http', url: 'https://y.test/mcp', headers: { 'X-Org': '${ORG}' } }],
      null,
    ],
    ['a bare name (ADR 0027)', ['sentry'], null],
    [
      'a literal header',
      [
        {
          name: 'x',
          transport: 'http',
          url: 'https://x.test',
          headers: { Authorization: 'Bearer v' },
        },
      ],
      'header Authorization holds a value',
    ],
    [
      'a literal env',
      [{ name: 'pg', transport: 'stdio', command: 'npx', env: { TOKEN: 'v' } }],
      'env TOKEN holds a value',
    ],
    ['an http URL off this Mac', [{ name: 'x', transport: 'http', url: 'http://x.test' }], 'https'],
    ['a stdio one without its command', [{ name: 'x', transport: 'stdio' }], 'expected string'],
    [
      'one name twice',
      ['sentry', { name: 'sentry', transport: 'http', url: SENTRY.url }],
      'named twice',
    ],
    ['github', ['github'], 'never a source'],
  ])('%s', (_, value, refusedWith) => {
    const read = SourceEntries.safeParse(value);

    if (refusedWith === null) expect(read.success).toBe(true);
    else expect(read.error?.issues.map((i) => i.message).join('; ')).toContain(refusedWith);
  });

  test("the repo's file read as the settings read it: one refused entry drops the list", () => {
    expect(repoSourcesOf({ sources: ['sentry'] })).toEqual(['sentry']);
    expect(repoSourcesOf({ board: {} })).toEqual([]);
    expect(repoSourcesOf({ sources: [{ name: 'x', transport: 'http', url: 'nope' }] })).toEqual([]);
  });

  test('a server of yours as an entry: its definition as it is, a literal value refused', () => {
    expect(sourceEntryOf('sentry', SENTRY)).toEqual({
      ok: true,
      entry: { name: 'sentry', transport: 'http', url: SENTRY.url },
    });
    expect(sourceEntryOf('stdio', { command: 'npx', args: ['m'] })).toEqual({
      ok: true,
      entry: { name: 'stdio', transport: 'stdio', command: 'npx', args: ['m'] },
    });
    const keyed = sourceEntryOf('keyed', config.projects[MAIN].mcpServers.keyed);

    expect(keyed.ok).toBe(false);
    expect(keyed.ok ? '' : keyed.why).toContain('header Authorization holds a value');
  });
});

describe("claudeServers: the main checkout's local scope, then your user scope", () => {
  test('marked by scope, Abe and github never', () => {
    expect(claudeServers({ config, mains: [MAIN] }).map((f) => [f.name, f.found])).toEqual([
      ['sentry', 'local-scope'],
      ['keyed', 'local-scope'],
      ['byVar', 'local-scope'],
      ['stdio', 'local-scope'],
      ['figma', 'user-scope'],
      ['other', 'user-scope'],
    ]);
  });
});

describe("sourceServers: the repo's sources: alone, each with its definition", () => {
  const SENTRY_ENTRY: SourceEntry = { name: 'sentry', transport: 'http', url: SENTRY.url };

  test.each<[string, readonly string[], SourceEntry[], Partial<ReturnType<typeof sourceServers>>]>([
    [
      'a defined one: its definition as Claude Code keeps it, whatever your scopes have',
      ['/home/me/demo'],
      [SENTRY_ENTRY],
      { loaded: ['sentry'], servers: { sentry: SENTRY }, missing: [], withheld: [] },
    ],
    [
      'a stdio one: its command and arguments',
      ['/home/me/demo'],
      [{ name: 'pg', transport: 'stdio', command: 'npx', args: ['pg-mcp'] }],
      { servers: { pg: { type: 'stdio', command: 'npx', args: ['pg-mcp'] } } },
    ],
    [
      'a server of yours sources: does not name: never loaded',
      [MAIN],
      [],
      { loaded: [], missing: [], withheld: [], servers: {} },
    ],
    [
      "a bare name: the main checkout's local scope's",
      [MAIN],
      ['sentry', 'byVar'],
      {
        loaded: ['sentry', 'byVar'],
        servers: { sentry: SENTRY, byVar: config.projects[MAIN].mcpServers.byVar },
      },
    ],
    ['a bare name only your user scope has: yours', [MAIN], ['figma'], { loaded: ['figma'] }],
    ['a bare name no scope has: missing', [MAIN], ['datadog'], { missing: ['datadog'] }],
    [
      'a bare name whose definition holds a value: withheld',
      [MAIN],
      ['keyed', 'stdio'],
      { loaded: [], withheld: ['keyed', 'stdio'] },
    ],
    [
      "a sibling checkout: none of the shop's local scope",
      ['/home/me/work/other'],
      ['sentry'],
      { loaded: [], missing: ['sentry'] },
    ],
  ])('%s', (_, mains, sources, want) => {
    expect(sourceServers({ config, mains, sources })).toMatchObject(want);
  });

  test('a server of Abe’s own name stays Abe’s; a config that is no JSON object gives none', () => {
    expect(
      sourceServers({ config, mains: [MAIN], sources: ['sentry', 'byVar'], abe: ['sentry'] })
        .loaded,
    ).toEqual(['byVar']);
    expect(sourceServers({ config: 'x', mains: [MAIN], sources: ['sentry'] })).toEqual({
      servers: {},
      loaded: [],
      missing: ['sentry'],
      withheld: [],
    });
  });

  test('the generated config: the definitions as they are, under mcpServers', () => {
    expect(JSON.parse(sourceServersConfig({ sentry: SENTRY }))).toEqual({
      mcpServers: { sentry: SENTRY },
    });
  });

  test.each<[string, readonly string[], readonly string[], string]>([
    [
      'one missing',
      ['datadog'],
      [],
      "Sources: this repo's datadog is not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources:",
    ],
    [
      'one withheld',
      ['keyed'],
      ['keyed'],
      "Sources: this repo's keyed is not loaded in this session: its server's definition holds a header or env value, and Abe copies no secret",
    ],
  ])('told: %s', (_, missing, withheld, starts) => {
    const told = sourcesTold({ sources: missing, missing, withheld, local: false, where: 'mac' });

    expect(told?.startsWith(starts)).toBe(true);
  });
});

test("the person's values fill a definition's ${VAR}s; one with none stays a reference", () => {
  expect(
    withSourceValues(
      {
        flags: {
          type: 'stdio',
          command: 'npx',
          args: ['flags-mcp'],
          env: { FLAGS_API_USER: '${FLAGS_API_USER}', FLAGS_API_PASSWORD: '${FLAGS_API_PASSWORD}' },
        },
        sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
      },
      new Map([['FLAGS_API_PASSWORD', 'fake-pass']]),
    ),
  ).toEqual({
    flags: {
      type: 'stdio',
      command: 'npx',
      args: ['flags-mcp'],
      env: { FLAGS_API_USER: '${FLAGS_API_USER}', FLAGS_API_PASSWORD: 'fake-pass' },
    },
    sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
  });
});
