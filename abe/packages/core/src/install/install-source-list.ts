/**
 * The team's sources as `abe install sources` lists them and `abe install source` adds one (ADR
 * 0031): the repo's `abe.yaml` `sources:`, then the servers the person's Claude Code has
 * for the main checkout that `sources:` does not define, marked where they were found, for the
 * install to offer once. Adding copies a found server's definition as it is (its sign-in is keyed
 * by name and definition, so it is reused), or takes a new one by URL or command. Never a secret,
 * never `claude mcp add` or `remove`. Pure: serve reads the files and writes the list.
 */
import { z } from 'zod';
import { refused, type Outcome } from '../command';
import {
  type FoundServer,
  type SourceEntry,
  SourceServerEntry,
  sourceDefinition,
  sourceEntryOf,
  sourceName,
  SOURCE_TRANSPORTS,
  SOURCE_VALUES_PATH,
} from './source-servers';

/** One row: a `sources:` entry, or a server found in the person's Claude Code (`found`). */
export const InstallSourceRow = z.object({
  name: z.string(),
  /** Its transport; null: no definition is known (a bare name no scope has, or one refused). */
  transport: z.enum(SOURCE_TRANSPORTS).nullable(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Not defined in `sources:`: where the person's Claude Code has it. */
  found: z.enum(['local-scope', 'user-scope']).optional(),
  /** `sources:` names it without a definition (ADR 0027's): `abe install source <name>` writes one. */
  bare: z.boolean().optional(),
  /** Why it can't be added as it is (a literal header or env value, none found). */
  why: z.string().optional(),
});
export type InstallSourceRow = z.infer<typeof InstallSourceRow>;

/** `abe install sources` and `abe install source`: the main checkout and its rows. */
export const InstallSourcesData = z.object({
  repo: z.string(),
  sources: z.array(InstallSourceRow),
});
export type InstallSourcesData = z.infer<typeof InstallSourcesData>;

const fields = (e: SourceServerEntry): Omit<InstallSourceRow, 'name'> =>
  e.transport === 'stdio'
    ? { transport: 'stdio', command: e.command, ...(e.args === undefined ? {} : { args: e.args }) }
    : { transport: e.transport, url: e.url };

const foundRow = (f: FoundServer): InstallSourceRow => {
  const entry = sourceEntryOf(f.name, f.definition);

  return entry.ok
    ? { name: f.name, ...fields(entry.entry), found: f.found }
    : { name: f.name, transport: null, found: f.found, why: entry.why };
};

/** Why a bare name can't be copied: no server of that name in the person's Claude Code. */
const noneFound = (name: string) =>
  `your Claude Code has no server named ${name} for this checkout: abe install source ${name} --url <its URL>`;

/** The rows: `sources:` in order, then each found server it does not name. */
export const sourceRows = (o: {
  sources: readonly SourceEntry[];
  found: readonly FoundServer[];
}): InstallSourceRow[] => [
  ...o.sources.map((s): InstallSourceRow => {
    if (typeof s !== 'string') return { name: s.name, ...fields(s) };
    const f = o.found.find((x) => x.name === s);

    return f === undefined
      ? { name: s, transport: null, bare: true, why: noneFound(s) }
      : { ...foundRow(f), bare: true };
  }),
  ...o.found.filter((f) => !o.sources.some((s) => sourceName(s) === f.name)).map(foundRow),
];

/** `abe install sources` as text: one line per row. */
export const installSourcesText = (d: InstallSourcesData): string =>
  d.sources.length === 0
    ? `${d.repo}: no sources, none found\n`
    : d.sources
        .map((r) => {
          const where =
            r.url ?? [r.command, ...(r.args ?? [])].filter((x) => x !== undefined).join(' ');
          const mark = r.found === undefined ? 'sources:' : `found: ${r.found}`;

          return `${r.name}  ${r.transport ?? '?'} ${where}  (${mark}${r.bare === true ? ', bare name' : ''})${r.why === undefined ? '' : `: ${r.why}`}\n`;
        })
        .join('');

/** A name for a server from its URL: its host's name below the top domain, `mcp.` and `api.` left out. */
export const sourceNameOfUrl = (url: string): string | undefined => {
  const host = /^https?:\/\/([^/:?#]+)/.exec(url)?.[1]?.toLowerCase();

  if (host === undefined) return undefined;
  const labels = host.split('.');
  const below = labels.length > 1 ? labels.slice(0, -1) : labels;
  const named = below.filter((l, n) => !(n === 0 && ['mcp', 'api', 'www'].includes(l)));

  return named.at(-1);
};

/** What `abe install source` was given: a name or a URL, and a new server's flags. */
export type SourceAsked = {
  name: string;
  url?: string | undefined;
  transport?: string | undefined;
  command?: string | undefined;
  args?: readonly string[] | undefined;
  /** A new stdio server's env keys, each written as a `${KEY}` reference (its value yours). */
  env?: readonly string[] | undefined;
  /** A new remote server's headers, `Name=VAR` each, written as `Name: ${VAR}`. */
  headers?: readonly string[] | undefined;
};

const VAR_NAME = /^[A-Za-z_]\w*$/;

/** `--env` keys and `--header Name=VAR` pairs as `${VAR}` references; why not, the one wrong. */
const referencesOf = (
  asked: SourceAsked,
):
  | { ok: true; env?: Record<string, string>; headers?: Record<string, string> }
  | { ok: false; why: string } => {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (const key of asked.env ?? []) {
    if (!VAR_NAME.test(key))
      return {
        ok: false,
        why: `--env ${key}: an env key's name, its value kept in ${SOURCE_VALUES_PATH}`,
      };
    env[key] = `\${${key}}`;
  }
  for (const pair of asked.headers ?? []) {
    const at = pair.indexOf('=');
    const header = pair.slice(0, at).trim();
    const name = pair.slice(at + 1).trim();

    if (at <= 0 || !VAR_NAME.test(name))
      return {
        ok: false,
        why: `--header ${pair}: Name=VAR, the VAR's value kept in ${SOURCE_VALUES_PATH}`,
      };
    headers[header] = `\${${name}}`;
  }

  return {
    ok: true,
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
};

const sameDefinition = (a: SourceServerEntry, b: SourceServerEntry) =>
  JSON.stringify(sourceDefinition(a)) === JSON.stringify(sourceDefinition(b));

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join('; ');

/**
 * `sources:` with the asked source in it: a found server's definition copied, or a new one by URL
 * or command; a bare name of it replaced in place, one defined the same left as it is. Refused:
 * a literal secret, a name with another definition already (Claude Code keys a sign-in by name
 * and definition: one name never gets two), no server of that name and no URL.
 */
export const withSource = (o: {
  asked: SourceAsked;
  sources: readonly SourceEntry[];
  found: readonly FoundServer[];
}): Outcome<SourceEntry[]> => {
  const { asked } = o;
  const isUrl = /^https?:\/\//.test(asked.name.trim());

  if (isUrl && asked.url !== undefined)
    return refused('usage', 'a URL once: abe install source <name> --url <url>, or <url>', 2);
  const url = isUrl ? asked.name.trim() : asked.url?.trim();
  const name = isUrl ? sourceNameOfUrl(url ?? '') : asked.name.trim();

  if (name === undefined || name === '')
    return refused(
      'usage',
      `${asked.name}: give its name too: abe install source <name> --url <url>`,
      2,
    );
  const theirs = o.found.find((f) => f.name === name);
  const typed = url !== undefined || asked.command !== undefined;
  let entry: SourceServerEntry;

  if (typed) {
    const transport = asked.transport ?? (asked.command === undefined ? 'http' : 'stdio');
    const refs = referencesOf(asked);

    if (!refs.ok) return refused('usage', `${name}: ${refs.why}`, 2);
    if (transport === 'stdio' ? refs.headers !== undefined : refs.env !== undefined)
      return refused(
        'usage',
        `${name}: --env is a stdio server's, --header an http or sse server's`,
        2,
      );
    const read = SourceServerEntry.safeParse(
      transport === 'stdio'
        ? {
            name,
            transport,
            command: asked.command,
            ...(asked.args === undefined || asked.args.length === 0 ? {} : { args: asked.args }),
            ...(refs.env === undefined ? {} : { env: refs.env }),
          }
        : {
            name,
            transport,
            url,
            ...(refs.headers === undefined ? {} : { headers: refs.headers }),
          },
    );

    if (!read.success) return refused('usage', `${name}: ${issues(read.error)}`, 2);
    entry = read.data;
    const had = theirs === undefined ? undefined : sourceEntryOf(name, theirs.definition);

    if (had !== undefined && !(had.ok && sameDefinition(had.entry, entry)))
      return refused(
        'source-there',
        `your Claude Code has a server named ${name} (${theirs?.found ?? 'local-scope'}) with another definition: one name never gets two (its sign-in is keyed by both). abe install source ${name} copies yours, or name this one otherwise`,
      );
  } else {
    const defined = o.sources.find(
      (s): s is SourceServerEntry => typeof s !== 'string' && s.name === name,
    );

    if (defined !== undefined) return { ok: true, data: [...o.sources] };
    if (theirs === undefined) return refused('no-source', noneFound(name));
    const copied = sourceEntryOf(name, theirs.definition);

    if (!copied.ok)
      return refused(
        'source-secret',
        `${name} can't go into sources: as it is: ${copied.why}. Add it by its definition with each secret as a reference (--command, --arg, --env <KEY>; or --url, --header <Name>=<VAR>), its value in your ${SOURCE_VALUES_PATH}`,
      );
    entry = copied.entry;
  }
  const at = o.sources.findIndex((s) => sourceName(s) === name);
  const was = o.sources[at];

  if (was !== undefined && typeof was !== 'string' && !sameDefinition(was, entry))
    return refused(
      'source-there',
      `sources: defines ${name} already, with another definition: one name never gets two (its sign-in is keyed by both). Change it in abe.yaml, or name this one otherwise`,
    );

  return {
    ok: true,
    data: at < 0 ? [...o.sources, entry] : o.sources.map((s, n) => (n === at ? entry : s)),
  };
};
