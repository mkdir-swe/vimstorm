/**
 * Factory install's sources (spec 3.0.1 "Read sources"): what a repo's sessions may read besides
 * the board and GitHub (Sentry, Figma, Datadog, …), found by Read in the repo itself. No fixed
 * list: every MCP server its config names is one, and the hints below (dependencies, config files,
 * links, env keys) name more. Each found one says what it is and why it was found (the file and
 * line); at the Sources stage the person answers Add or Skip per source, and an added one's
 * server goes into the main checkout's Claude Code local scope (ADR 0027). Pure: serve hands it
 * the files' text and the checkout's top names.
 */
import { z } from 'zod';

export const FoundSource = z.object({
  /** Its name in `sources:`: the MCP server's, or the hint's (`sentry`). */
  id: z.string().min(1),
  /** How the page says it: `Sentry`. */
  name: z.string(),
  /** What it is: `errors and issues`, `an MCP server`. */
  what: z.string(),
  /** Why it was found: the file and line, and what was there (`package.json:12 @sentry/react`). */
  why: z.string(),
  /** The MCP server the repo's config names for it; null: only a hint (the person's own, by its id). */
  mcp: z.string().nullable(),
  /**
   * The repo's config's definition for it, when it is a remote server with no header or env
   * value (`http` or `sse`, its URL): offered at Sources as the person's own (ADR 0027). Null:
   * a command, one that holds a value, or only a hint.
   */
  remote: z
    .object({ transport: z.enum(['http', 'sse']), url: z.string() })
    .nullable()
    .default(null),
});
export type FoundSource = z.infer<typeof FoundSource>;

/** A remote MCP server's definition: its transport and URL, nothing else (ADR 0027). */
export type RemoteServer = { transport: 'http' | 'sse'; url: string };

/**
 * The sources the hints know by name: their words, and the vendor's own remote MCP server where
 * there is one (signed in with OAuth, no key). Any other MCP server is its own name.
 */
export const KNOWN_SOURCES: Readonly<
  Record<string, { name: string; what: string; server?: RemoteServer }>
> = {
  sentry: {
    name: 'Sentry',
    what: 'errors and issues',
    server: { transport: 'http', url: 'https://mcp.sentry.dev/mcp' },
  },
  figma: {
    name: 'Figma',
    what: 'designs',
    server: { transport: 'http', url: 'https://mcp.figma.com/mcp' },
  },
  datadog: { name: 'Datadog', what: 'logs, metrics and traces' },
  launchdarkly: { name: 'LaunchDarkly', what: 'feature flags' },
  posthog: { name: 'PostHog', what: 'product analytics' },
  confluence: {
    name: 'Confluence',
    what: 'docs',
    server: { transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse' },
  },
  notion: {
    name: 'Notion',
    what: 'docs',
    server: { transport: 'http', url: 'https://mcp.notion.com/mcp' },
  },
  linear: {
    name: 'Linear',
    what: 'issues',
    server: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
  },
  grafana: { name: 'Grafana', what: 'dashboards and logs' },
};

/** Where a source's offered definition comes from: a known system's, or the repo's config's. */
export type SourceOffer = RemoteServer & { from: 'known' | 'repo' };

/**
 * The definition the Sources stage offers for a found source: the repo's config's remote one,
 * offered as the person's own, else the known system's. Null: none known, the person types its URL.
 */
export const sourceOffer = (s: Pick<FoundSource, 'id' | 'remote'>): SourceOffer | null => {
  if (s.remote !== null) return { ...s.remote, from: 'repo' };
  const server = KNOWN_SOURCES[s.id.toLowerCase()]?.server;

  return server === undefined ? null : { ...server, from: 'known' };
};

/** A URL a typed source may have: https, or http on this Mac. */
export const sourceUrlOk = (url: string): boolean =>
  /^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);

/** A source's server name as the install adds it: lower case, word characters and dashes. */
export const SOURCE_NAME = /^[a-z0-9][\w.-]*$/;

/** The MCP config files Read looks at, and the key their servers are under. */
export const MCP_FILES: Readonly<Record<string, 'mcpServers' | 'servers'>> = {
  '.mcp.json': 'mcpServers',
  '.claude/settings.json': 'mcpServers',
  '.claude/settings.local.json': 'mcpServers',
  '.cursor/mcp.json': 'mcpServers',
  '.vscode/mcp.json': 'servers',
};

/** The board and GitHub are read anyway; Abe is the session's own. */
const NOT_SOURCES = new Set(['github', 'abe']);

/** A dependency's name that hints a source. */
const DEPENDENCIES: readonly [RegExp, string][] = [
  [/^@sentry\//, 'sentry'],
  [/^(posthog-js|posthog-node|posthog-react-native)$/, 'posthog'],
  [/^(launchdarkly-|@launchdarkly\/)/, 'launchdarkly'],
  [/^(dd-trace|@datadog\/)/, 'datadog'],
  [/^@figma\//, 'figma'],
];

/** A file at the checkout's top or a workspace's that hints a source. */
const CONFIG_NAMES: readonly [RegExp, string][] = [
  [/^sentry\.[\w.-]*config\.[cm]?[jt]s$/, 'sentry'],
  [/^\.sentryclirc$/, 'sentry'],
  [/^datadog\.ya?ml$/, 'datadog'],
];

/** A link in the docs that hints a source. */
const LINKS: readonly [RegExp, string][] = [
  [/https?:\/\/(?:www\.)?figma\.com\/(?:file|design|proto|board)\/\S+/i, 'figma'],
  [/https?:\/\/[\w-]+\.sentry\.io\S*|https?:\/\/sentry\.io\/organizations\/\S+/i, 'sentry'],
  [/https?:\/\/app\.datadoghq\.(?:com|eu)\S*/i, 'datadog'],
  [/https?:\/\/[\w-]+\.atlassian\.net\/wiki\S*/i, 'confluence'],
  [/https?:\/\/(?:www\.)?notion\.so\/\S+/i, 'notion'],
  [/https?:\/\/linear\.app\/\S+/i, 'linear'],
];

/** An env example key that hints a source. */
const ENV_KEYS: readonly [RegExp, string][] = [
  [/SENTRY_(DSN|AUTH_TOKEN|ORG|PROJECT)$/, 'sentry'],
  [/POSTHOG_(KEY|HOST)$/, 'posthog'],
  [/^DD_(API_KEY|SITE|SERVICE)$/, 'datadog'],
  [/LAUNCHDARKLY_\w*KEY$/, 'launchdarkly'],
  [/^FIGMA_\w+$/, 'figma'],
];

/** The docs Read looks in for links, beside the README. */
export const DOC_FILES = ['README.md', 'README', 'CLAUDE.md', 'AGENTS.md'] as const;

const lineOf = (text: string, needle: string): number => {
  const at = text.indexOf(needle);

  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
};

const known = (id: string) => KNOWN_SOURCES[id] ?? { name: id, what: 'an MCP server' };

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const Servers = z.record(z.string(), z.unknown());
const Package = z.object({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
});

/** The MCP servers a config file names. */
const mcpServers = (path: string, text: string): FoundSource[] => {
  const key = MCP_FILES[path];
  const doc = z.record(z.string(), z.unknown()).safeParse(parse(text));

  if (key === undefined || !doc.success) return [];
  const servers = Servers.safeParse(doc.data[key]);

  return servers.success
    ? Object.keys(servers.data)
        .filter((name) => !NOT_SOURCES.has(name.toLowerCase()))
        .map((name) => {
          const hint = Object.keys(KNOWN_SOURCES).find((id) => name.toLowerCase().includes(id));
          const words = known(hint ?? name);

          return {
            id: name,
            name: hint === undefined ? name : words.name,
            what: words.what,
            why: `${path}:${lineOf(text, `"${name}"`)} ${key}.${name}`,
            mcp: name,
            remote: remoteOf(servers.data[name]),
          };
        })
    : [];
};

const hinted = (id: string, why: string): FoundSource => ({
  id,
  name: known(id).name,
  what: known(id).what,
  why,
  mcp: null,
  remote: null,
});

const Remote = z.object({
  type: z.enum(['http', 'sse', 'streamable-http']).optional(),
  url: z.string().refine(sourceUrlOk),
  headers: z.undefined(),
  env: z.undefined(),
});

/** A repo config's server as a remote definition the person may take as theirs; null: not one. */
const remoteOf = (def: unknown): RemoteServer | null => {
  const r = Remote.safeParse(def);

  if (!r.success) return null;

  return { transport: r.data.type === 'sse' ? 'sse' : 'http', url: r.data.url };
};

/**
 * The repo's sources, from its files (path → text; each package.json, the root's and its
 * workspaces'), the names at its top and in its workspaces (`backend/sentry.config.ts`) and its env
 * examples' keys: each once, the MCP servers its config names first, then the hints, in file order.
 */
export const foundSources = (o: {
  files: ReadonlyMap<string, string>;
  names: readonly string[];
  envs: readonly { file: string; keys: readonly string[] }[];
}): FoundSource[] => {
  const found: FoundSource[] = [];
  const add = (s: FoundSource) => {
    const id = s.id.toLowerCase();

    if (found.some((f) => f.id.toLowerCase() === id || f.mcp?.toLowerCase().includes(id))) return;
    found.push(s);
  };

  for (const [path, text] of o.files) for (const s of mcpServers(path, text)) add(s);
  for (const [path, text] of o.files) {
    const pkg =
      path === 'package.json' || path.endsWith('/package.json')
        ? Package.safeParse(parse(text)).data
        : undefined;

    for (const dep of Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }))
      for (const [re, id] of DEPENDENCIES)
        if (re.test(dep)) add(hinted(id, `${path}:${lineOf(text, `"${dep}"`)} ${dep}`));
  }
  for (const name of o.names)
    for (const [re, id] of CONFIG_NAMES)
      if (re.test(name.slice(name.lastIndexOf('/') + 1))) add(hinted(id, name));
  for (const [path, text] of o.files) {
    if (!DOC_FILES.some((d) => d === path) && !/^docs\/.+\.md$/.test(path)) continue;
    for (const [re, id] of LINKS) {
      const m = re.exec(text);

      if (m !== null) add(hinted(id, `${path}:${lineOf(text, m[0])} ${m[0]}`));
    }
  }
  for (const e of o.envs)
    for (const key of e.keys)
      for (const [re, id] of ENV_KEYS) if (re.test(key)) add(hinted(id, `${e.file} ${key}`));

  return found;
};
