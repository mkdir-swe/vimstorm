/**
 * Source servers (ADR 0031): the team's MCP servers, in the repo's `abe.yaml`
 * `sources:` (name, transport, URL or command), and the MCP config Abe generates of them for a
 * card's, a linked worktree's or an install's session on this Mac. Each goes into the config with
 * its name and the definition Claude Code keeps for it (`type`, `url`, `headers`; or `command`,
 * `args`, `env`), so the sign-in Claude Code stored for that name and definition is the session's
 * too. A header or env value in `sources:` is a `${VAR}` reference, never a literal: the repo's
 * file holds no secret. A bare name (ADR 0027's `sources:`) is the server of that name in the main
 * checkout's Claude Code local scope, then the person's user scope, until the install writes its
 * definition (`abe install source <name>`). Never a repo's `.mcp.json`. Pure: the runner reads the
 * files.
 */
import { z } from 'zod';
import { REPO_PATH } from '../layer/settings/places';
import { sourceUrlOk } from './install-sources';

/** The board and GitHub are read anyway; Abe's is the session's own. */
const NOT_SOURCES = new Set(['abe', 'github']);

/** A value Claude Code fills from the environment at launch, not a value of its own. */
const REFERENCE = /^\$\{[A-Za-z_]\w*\}$/;

/** A source's name: its MCP server's, as Claude Code names it. */
export const SOURCE_SERVER_NAME = /^[\w.@-]+$/;

/** How a source's MCP server is reached: Claude Code's `type`. */
export const SOURCE_TRANSPORTS = ['http', 'sse', 'stdio'] as const;
export type SourceTransport = (typeof SOURCE_TRANSPORTS)[number];

const SourceName = z
  .string()
  .regex(SOURCE_SERVER_NAME, 'a source: its MCP server name, like sentry')
  .refine((n) => !NOT_SOURCES.has(n.toLowerCase()), {
    message: 'abe and github are read anyway, never a source',
  });

/** Why a literal header or env value is refused: the team's file never holds a secret. */
export const literalRefused = (what: 'header' | 'env', key: string): string =>
  `${what} ${key} holds a value: ${REPO_PATH} is the team's and never holds a secret; write a \${VAR} reference, or leave it out and sign in (Claude Code keeps the token)`;

const references = (what: 'header' | 'env') =>
  z.record(z.string(), z.string()).superRefine((values, ctx) => {
    for (const [key, value] of Object.entries(values))
      if (!REFERENCE.test(value))
        ctx.addIssue({ code: 'custom', path: [key], message: literalRefused(what, key) });
  });

/** A remote source: its server's URL, over http or sse. */
const RemoteSource = z.strictObject({
  name: SourceName,
  transport: z.enum(['http', 'sse']),
  url: z.string().refine(sourceUrlOk, {
    message: "an MCP server's URL: https (or http on localhost)",
  }),
  headers: references('header').optional(),
});

/** A source started on this Mac: its command and arguments. */
const StdioSource = z.strictObject({
  name: SourceName,
  transport: z.literal('stdio'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  env: references('env').optional(),
});

/** A source's server as `sources:` defines it. */
export const SourceServerEntry = z.discriminatedUnion('transport', [RemoteSource, StdioSource]);
export type SourceServerEntry = z.infer<typeof SourceServerEntry>;

/**
 * One entry of `sources:`: a server's definition, or a bare name (ADR 0027's, read from your
 * Claude Code until the install writes its definition).
 */
export const SourceEntry = z.union([SourceName, SourceServerEntry], {
  // said as the entry's own kind: a name's issue for a name, a definition's for the rest
  error: (iss) => {
    const own = typeof iss.input === 'string' ? iss.errors[0] : iss.errors[1];

    return own?.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  },
});
export type SourceEntry = z.infer<typeof SourceEntry>;

/** An entry's name. */
export const sourceName = (e: SourceEntry): string => (typeof e === 'string' ? e : e.name);

/** `sources:`: each name once, one definition per name. */
export const SourceEntries = z.array(SourceEntry).superRefine((entries, ctx) => {
  const seen = new Set<string>();

  for (const [n, e] of entries.entries()) {
    const name = sourceName(e);

    if (seen.has(name))
      ctx.addIssue({
        code: 'custom',
        path: [n],
        message: `${name} is named twice: one name has one definition (Claude Code keys its sign-in by both)`,
      });
    seen.add(name);
  }
});

/** A lower Layer's entries over the ones above: one of the same name replaces it, the rest added. */
export const addSources = (above: SourceEntry[], written: SourceEntry[]): SourceEntry[] => [
  ...above.map((a) => written.find((w) => sourceName(w) === sourceName(a)) ?? a),
  ...written.filter((w) => !above.some((a) => sourceName(a) === sourceName(w))),
];

/** The definition Claude Code keeps for an entry: what its sign-in is keyed by, with the name. */
export const sourceDefinition = (e: SourceServerEntry): Record<string, unknown> =>
  e.transport === 'stdio'
    ? {
        type: 'stdio',
        command: e.command,
        args: e.args ?? [],
        ...(e.env === undefined ? {} : { env: e.env }),
      }
    : { type: e.transport, url: e.url, ...(e.headers === undefined ? {} : { headers: e.headers }) };

const Strings = z.record(z.string(), z.string());

/** A definition as Claude Code keeps one, read only as far as `sources:` takes it. */
const ClaudeRemote = z.looseObject({
  type: z.enum(['http', 'sse']),
  url: z.string(),
  headers: Strings.optional(),
});
const ClaudeStdio = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: Strings.optional(),
});

const some = (o: Record<string, string> | undefined) =>
  o !== undefined && Object.keys(o).length > 0;

/** A server of the person's Claude Code as `sources:` would have it, before its checks. */
const candidateOf = (name: string, definition: unknown): unknown => {
  const remote = ClaudeRemote.safeParse(definition);

  if (remote.success) {
    const { type, url, headers } = remote.data;

    return { name, transport: type, url, ...(some(headers) ? { headers } : {}) };
  }
  const stdio = ClaudeStdio.safeParse(definition);

  if (!stdio.success) return undefined;
  const { command, args, env } = stdio.data;

  return {
    name,
    transport: 'stdio',
    command,
    ...(args === undefined || args.length === 0 ? {} : { args }),
    ...(some(env) ? { env } : {}),
  };
};

/**
 * A server of the person's Claude Code as a `sources:` entry, its definition as it is; why not:
 * it holds a literal header or env value, or is no definition `sources:` takes.
 */
export const sourceEntryOf = (
  name: string,
  definition: unknown,
): { ok: true; entry: SourceServerEntry } | { ok: false; why: string } => {
  const candidate = candidateOf(name, definition);

  if (candidate === undefined)
    return { ok: false, why: `${name}'s definition is none sources: takes` };
  const entry = SourceServerEntry.safeParse(candidate);

  return entry.success
    ? { ok: true, entry: entry.data }
    : { ok: false, why: entry.error.issues.map((i) => i.message).join('; ') };
};

const Servers = z.record(z.string(), z.unknown());
const Config = z.looseObject({
  mcpServers: Servers.optional(),
  projects: z.record(z.string(), z.looseObject({ mcpServers: Servers.optional() })).optional(),
});

const Definition = z.looseObject({
  headers: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});

/** Whether a definition holds a literal header or env value (never said, only seen). */
const holdsValue = (definition: unknown): boolean => {
  const d = Definition.safeParse(definition);

  if (!d.success) return true;

  return [...Object.values(d.data.headers ?? {}), ...Object.values(d.data.env ?? {})].some(
    (v) => typeof v !== 'string' || !REFERENCE.test(v),
  );
};

/** Where a server of the person's Claude Code is: the main checkout's local scope, or theirs. */
export type FoundScope = 'local-scope' | 'user-scope';

/** A server the person's Claude Code has for the main checkout, by scope: its definition. */
export type FoundServer = { name: string; found: FoundScope; definition: unknown };

/**
 * The servers the person's Claude Code config (`config`, its parsed JSON) has for a main checkout
 * (`mains`, as given and real): its local scope's, then the user scope's of other names. Abe's
 * own and github never.
 */
export const claudeServers = (o: {
  config: unknown;
  mains: readonly string[];
  abe?: readonly string[];
}): FoundServer[] => {
  const config = Config.safeParse(o.config);
  const doc = config.success ? config.data : {};
  const skip = (name: string) =>
    NOT_SOURCES.has(name.toLowerCase()) || (o.abe ?? []).includes(name);
  const found: FoundServer[] = [];
  const add = (name: string, definition: unknown, scope: FoundScope) => {
    if (!skip(name) && !found.some((f) => f.name === name))
      found.push({ name, found: scope, definition });
  };

  for (const main of o.mains)
    for (const [name, def] of Object.entries(doc.projects?.[main]?.mcpServers ?? {}))
      add(name, def, 'local-scope');
  for (const [name, def] of Object.entries(doc.mcpServers ?? {})) add(name, def, 'user-scope');

  return found;
};

export type SourceServers = {
  /** The generated config's servers, by name: each definition as `sources:` gives it. */
  servers: Record<string, unknown>;
  /** Their names, in `sources:`' order. */
  loaded: string[];
  /** The bare names neither scope of your Claude Code has a server for. */
  missing: string[];
  /** Bare names not copied: your Claude Code's definition holds a header or env value. */
  withheld: string[];
};

/**
 * The source servers for a session whose main checkout is one of `mains`: the repo's `sources:`
 * (`sources`), each defined one as it is, a bare name from the person's Claude Code config
 * (`config`) as `claudeServers` finds it. Abe's own servers' names (`abe`) stay Abe's. A server
 * of the person's that `sources:` does not name never loads.
 */
export const sourceServers = (o: {
  config: unknown;
  mains: readonly string[];
  sources: readonly SourceEntry[];
  abe?: readonly string[];
}): SourceServers => {
  const skip = (name: string) =>
    NOT_SOURCES.has(name.toLowerCase()) || (o.abe ?? []).includes(name);
  const bare = o.sources.some((s) => typeof s === 'string');
  const theirs = bare ? claudeServers({ config: o.config, mains: o.mains }) : [];
  const servers: Record<string, unknown> = {};
  const loaded: string[] = [];
  const missing: string[] = [];
  const withheld: string[] = [];

  for (const s of o.sources) {
    const name = sourceName(s);

    if (skip(name) || loaded.includes(name)) continue;
    if (typeof s !== 'string') {
      servers[name] = sourceDefinition(s);
      loaded.push(name);
      continue;
    }
    const def = theirs.find((t) => t.name === name)?.definition;

    if (def === undefined) missing.push(name);
    else if (holdsValue(def)) withheld.push(name);
    else {
      servers[name] = def;
      loaded.push(name);
    }
  }

  return { servers, loaded, missing, withheld };
};

/**
 * Where each person's values for the `${VAR}` references in `sources:` are kept: in their own
 * `.abe/`, out of git, `NAME=value` a line (an API user, a token a server needs). Filled into the
 * MCP config Abe generates (mode 600, out of a session's reach), never into a session's env.
 */
export const SOURCE_VALUES_PATH = '.abe/sources.env';

const fill = (
  refs: Readonly<Record<string, string>> | undefined,
  values: ReadonlyMap<string, string>,
): Record<string, string> | undefined =>
  refs === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(refs).map(([k, v]) => {
          const name = REFERENCE.test(v) ? v.slice(2, -1) : undefined;
          const value = name === undefined ? undefined : values.get(name);

          return [k, value === undefined || value === '' ? v : value];
        }),
      );

/**
 * The generated config's servers with each `${VAR}` reference of their `env` and `headers` filled
 * from the person's values (`SOURCE_VALUES_PATH`); one they have no value for stays a reference,
 * which Claude Code fills from its own environment.
 */
export const withSourceValues = (
  servers: Readonly<Record<string, unknown>>,
  values: ReadonlyMap<string, string>,
): Record<string, unknown> =>
  values.size === 0
    ? { ...servers }
    : Object.fromEntries(
        Object.entries(servers).map(([name, def]) => {
          const d = Definition.safeParse(def);

          if (!d.success) return [name, def];
          const strings = (o: Record<string, unknown> | undefined) =>
            o === undefined
              ? undefined
              : Object.fromEntries(
                  Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
                );
          const env = fill(strings(d.data.env), values);
          const headers = fill(strings(d.data.headers), values);

          return [
            name,
            {
              ...d.data,
              ...(env === undefined ? {} : { env }),
              ...(headers === undefined ? {} : { headers }),
            },
          ];
        }),
      );

/** The `${VAR}` names `sources:`' definitions reference, each once, in order. */
export const sourceReferences = (sources: readonly SourceEntry[]): string[] => [
  ...new Set(
    sources.flatMap((s) =>
      typeof s === 'string'
        ? []
        : Object.values((s.transport === 'stdio' ? s.env : s.headers) ?? {}).map((v) =>
            v.slice(2, -1),
          ),
    ),
  ),
];

/** The generated MCP config's text: `{ mcpServers }`, for `--mcp-config` (mode 600, out of reach). */
export const sourceServersConfig = (servers: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;

const RepoDoc = z.looseObject({ sources: z.unknown().optional() });

/**
 * The `sources:` of the repo's `abe.yaml` (`doc`, as parsed), read as the settings read
 * it: none when there are none, or when one entry is refused (the whole entry is dropped).
 */
export const repoSourcesOf = (doc: unknown): SourceEntry[] => {
  const d = RepoDoc.safeParse(doc);
  const s = SourceEntries.safeParse(d.success ? (d.data.sources ?? []) : []);

  return s.success ? s.data : [];
};
