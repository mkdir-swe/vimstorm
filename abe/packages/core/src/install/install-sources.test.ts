/** Factory install's sources: what Read finds in the repo itself, each with what and why. */
import { describe, expect, test } from 'bun:test';
import { foundSources } from './install-sources';

type Found = [string, string, string, string | null][];
const found = (
  files: Record<string, string>,
  o: { names?: string[]; envKeys?: string[] } = {},
): Found =>
  foundSources({
    files: new Map(Object.entries(files)),
    names: o.names ?? [],
    envs: [{ file: '.env.example', keys: o.envKeys ?? [] }],
  }).map((s) => [s.id, s.name, s.why, s.mcp]);

const PKG = '{\n  "dependencies": {\n    "react": "19",\n    "@sentry/react": "9"\n  }\n}\n';

describe('foundSources: no fixed list, each found once with why', () => {
  test.each<[string, Record<string, string>, { names?: string[]; envKeys?: string[] }, Found]>([
    ['nothing hints one', { 'package.json': '{"dependencies":{"react":"19"}}' }, {}, []],
    [
      "an MCP server the repo's config names, by its own name",
      { '.mcp.json': '{\n  "mcpServers": {\n    "datadog": {},\n    "acme-wiki": {}\n  }\n}' },
      {},
      [
        ['datadog', 'Datadog', '.mcp.json:3 mcpServers.datadog', 'datadog'],
        ['acme-wiki', 'acme-wiki', '.mcp.json:4 mcpServers.acme-wiki', 'acme-wiki'],
      ],
    ],
    [
      "VS Code's servers; GitHub and Abe are no sources",
      { '.vscode/mcp.json': '{"servers":{"github":{},"abe":{},"figma":{}}}' },
      {},
      [['figma', 'Figma', '.vscode/mcp.json:1 servers.figma', 'figma']],
    ],
    [
      'a dependency, by its line',
      { 'package.json': PKG },
      {},
      [['sentry', 'Sentry', 'package.json:4 @sentry/react', null]],
    ],
    [
      'a config file at the top',
      {},
      { names: ['sentry.client.config.ts', 'src'] },
      [['sentry', 'Sentry', 'sentry.client.config.ts', null]],
    ],
    [
      "a workspace's config file, by its path",
      {},
      { names: ['backend/sentry.server.config.ts'] },
      [['sentry', 'Sentry', 'backend/sentry.server.config.ts', null]],
    ],
    [
      'a link in the docs',
      {
        'docs/design.md': '# Design\n\nSee https://www.figma.com/design/abc/Shop for the flows.\n',
      },
      {},
      [['figma', 'Figma', 'docs/design.md:3 https://www.figma.com/design/abc/Shop', null]],
    ],
    [
      "an env example's key",
      {},
      { envKeys: ['DATABASE_URL', 'NEXT_PUBLIC_POSTHOG_KEY'] },
      [['posthog', 'PostHog', '.env.example NEXT_PUBLIC_POSTHOG_KEY', null]],
    ],
    [
      'an MCP server and a hint of the same source: the server, once',
      { '.mcp.json': '{"mcpServers":{"sentry-mcp":{}}}', 'package.json': PKG },
      { names: ['sentry.server.config.js'] },
      [['sentry-mcp', 'Sentry', '.mcp.json:1 mcpServers.sentry-mcp', 'sentry-mcp']],
    ],
    ['a config that is no JSON', { '.mcp.json': '{ mcpServers: ' }, {}, []],
  ])('%s', (_, files, o, want) => {
    expect(found(files, o)).toEqual(want);
  });
});
