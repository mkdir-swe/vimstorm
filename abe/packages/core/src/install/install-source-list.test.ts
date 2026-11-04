/** `abe install sources` and `abe install source` (ADR 0031): the team's list, and one added. */
import { describe, expect, test } from 'bun:test';
import {
  type FoundServer,
  type SourceEntry,
  sourceNameOfUrl,
  sourceRows,
  withSource,
} from '../index';

const SENTRY_URL = 'https://mcp.sentry.dev/mcp';
const SENTRY: SourceEntry = { name: 'sentry', transport: 'http', url: SENTRY_URL };
const found: FoundServer[] = [
  { name: 'sentry', found: 'local-scope', definition: { type: 'http', url: SENTRY_URL } },
  {
    name: 'keyed',
    found: 'local-scope',
    definition: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer v' } },
  },
  {
    name: 'figma',
    found: 'user-scope',
    definition: { type: 'http', url: 'https://mcp.figma.com/mcp' },
  },
];

describe('sourceRows: sources: first, then what your Claude Code has that it does not define', () => {
  test('marked by scope; a bare name with the definition found; a literal value said why', () => {
    const rows = sourceRows({ sources: [SENTRY, 'figma'], found });

    expect(rows.at(-1)?.why).toContain('header Authorization holds a value');
    expect(rows.map((r) => ({ ...r, why: r.why === undefined ? null : 'said' }))).toEqual([
      { name: 'sentry', transport: 'http', url: SENTRY_URL, why: null },
      {
        name: 'figma',
        transport: 'http',
        url: 'https://mcp.figma.com/mcp',
        found: 'user-scope',
        bare: true,
        why: null,
      },
      {
        name: 'keyed',
        transport: null,
        found: 'local-scope',
        why: 'said',
      },
    ]);
  });

  test('a bare name no scope has: said how to add it', () => {
    const [row] = sourceRows({ sources: ['datadog'], found: [] });

    expect(row).toMatchObject({ name: 'datadog', transport: null, bare: true });
    expect(row?.why).toContain('--url');
  });
});

describe('withSource: one added to sources:, never a secret, one name one definition', () => {
  test.each<[string, Parameters<typeof withSource>[0]['asked'], SourceEntry[], SourceEntry[]]>([
    ['a found one: its definition copied', { name: 'sentry' }, [], [SENTRY]],
    [
      'a bare name: replaced in place by its definition',
      { name: 'sentry' },
      ['a', 'sentry'],
      ['a', SENTRY],
    ],
    ['defined already the same: as it is', { name: 'sentry' }, [SENTRY], [SENTRY]],
    [
      'a new one by URL: its name from the host',
      { name: 'https://mcp.linear.app/mcp' },
      [],
      [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' }],
    ],
    [
      'a new one by name and URL, over sse',
      { name: 'jira', url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse' },
      [],
      [{ name: 'jira', transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse' }],
    ],
    [
      'a new stdio one',
      { name: 'pg', command: 'npx', args: ['pg-mcp'] },
      [],
      [{ name: 'pg', transport: 'stdio', command: 'npx', args: ['pg-mcp'] }],
    ],
    ['the same URL your Claude Code has under that name', { name: SENTRY_URL }, [], [SENTRY]],
    [
      'a new stdio one needing secrets: each env key a reference, its value yours',
      {
        name: 'flags',
        command: 'npx',
        args: ['-y', 'flags-mcp'],
        env: ['FLAGS_API_USER', 'FLAGS_API_PASSWORD'],
      },
      [],
      [
        {
          name: 'flags',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'flags-mcp'],
          env: { FLAGS_API_USER: '${FLAGS_API_USER}', FLAGS_API_PASSWORD: '${FLAGS_API_PASSWORD}' },
        },
      ],
    ],
    [
      'a new http one with a header by reference',
      { name: 'flags', url: 'https://flags.test/mcp', headers: ['Authorization=FLAGS_TOKEN'] },
      [],
      [
        {
          name: 'flags',
          transport: 'http',
          url: 'https://flags.test/mcp',
          headers: { Authorization: '${FLAGS_TOKEN}' },
        },
      ],
    ],
  ])('%s', (_, asked, sources, want) => {
    expect(withSource({ asked, sources, found })).toEqual({ ok: true, data: want });
  });

  test.each<[string, Parameters<typeof withSource>[0]['asked'], SourceEntry[], string, string]>([
    [
      'a literal header',
      { name: 'keyed' },
      [],
      'source-secret',
      'header Authorization holds a value',
    ],
    ['none found, no URL', { name: 'datadog' }, [], 'no-source', '--url'],
    [
      'a name your Claude Code has with another definition',
      { name: 'sentry', url: 'https://other.test/mcp' },
      [],
      'source-there',
      'one name never gets two',
    ],
    [
      'a name sources: defines otherwise',
      { name: 'pg', url: 'https://pg.test/mcp' },
      [{ name: 'pg', transport: 'stdio', command: 'npx' }],
      'source-there',
      'defines pg already',
    ],
    ['an http URL off this Mac', { name: 'x', url: 'http://x.test' }, [], 'usage', 'https'],
    ['a URL twice', { name: SENTRY_URL, url: SENTRY_URL }, [], 'usage', 'a URL once'],
  ])('refused: %s', (_, asked, sources, code, says) => {
    const r = withSource({ asked, sources, found });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.message).toContain(says);
      expect(r.error.message).not.toContain('Bearer');
    }
  });
});

describe('sourceNameOfUrl: the host below its top domain, mcp. and api. left out', () => {
  test.each<[string, string | undefined]>([
    ['https://mcp.sentry.dev/mcp', 'sentry'],
    ['https://mcp.eu.sentry.io/mcp', 'sentry'],
    ['https://api.githubcopilot.com/mcp/', 'githubcopilot'],
    ['http://localhost:3845/mcp', 'localhost'],
    ['nope', undefined],
  ])('%s', (url, name) => {
    expect(sourceNameOfUrl(url)).toBe(name);
  });
});
