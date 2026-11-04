/**
 * The repo's sources in a Factory run and a box's session, which load MCP servers only from
 * `--mcp-config` (`--strict-mcp-config`): from the config Abe generates of the repo's `sources:`
 * (`source-servers.ts`, ADR 0031; on a box the Mac's synced `abe.yaml`'s, 3.2.1, its sign-in the
 * Mac's token, `box-sync.ts`); never from a repo's `.mcp.json`. Only
 * Abe's own servers and the sources start (`allowedMcpServers`). A source no file names does not load there: the session is
 * told, and its record keeps it. The runner says the sources' line, once it knows which loaded.
 * Pure: the runner reads the files, their servers' names only.
 */
import { z } from 'zod';
import type { ClaudeSettings } from '../session/session';
import { REPO_PATH } from '../layer/settings/places';
import { sourcesLine } from './source-tools';

const Servers = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()) });

/** The MCP server names a config file's text has (its `mcpServers` keys, never a value). */
export const mcpServerNames = (text: string): string[] => {
  try {
    const doc = Servers.safeParse(JSON.parse(text));

    return doc.success ? Object.keys(doc.data.mcpServers) : [];
  } catch {
    return [];
  }
};

/** A session's settings with only `allowed` MCP servers started. */
export const withServersAllowed = (
  settings: ClaudeSettings,
  allowed: readonly string[],
): ClaudeSettings => ({
  ...settings,
  allowedMcpServers: allowed.map((serverName) => ({ serverName })),
});

/**
 * A workspace's managed settings with the sources' rules (`sourceRules`) in them: there they are
 * the only rules that count (`allowManagedPermissionRulesOnly`), the session's `--settings` not.
 */
export const withSourceRules = (
  managed: ClaudeSettings,
  rules: { allow: readonly string[]; deny: readonly string[] },
): ClaudeSettings =>
  rules.allow.length === 0 && rules.deny.length === 0
    ? managed
    : {
        ...managed,
        permissions: {
          ...managed.permissions,
          allow: [...(managed.permissions?.allow ?? []), ...rules.allow],
          deny: [...(managed.permissions?.deny ?? []), ...rules.deny],
        },
      };

const listed = (names: readonly string[]) => names.join(', ');

const AFTER =
  'Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.';

/** Why a source did not load in a card's or an install's session on this Mac. */
const NOT_IN_RUN = `not loaded in this session: a session on this machine loads a source only from the repo's ${REPO_PATH} sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there.`;

/** Why a source's server was not copied into the session's MCP config (`SourceServers.withheld`). */
const WITHHELD =
  "not loaded in this session: its server's definition holds a header or env value, and Abe copies no secret into a session's MCP config.";

/**
 * Why a source's server did not load in a session on this Mac: no check at the install passed
 * for it (`checkedSourceServers`), so it is not started, whatever the config has.
 */
const NOT_CHECKED =
  "not checked at install, so not loaded in this session: a session on this machine starts a source's server only once the install signed it in and its one read passed (abe install runs it again).";

/** The same on a box (3.2.1): the Mac's install's checks are the ones that count. */
const NOT_CHECKED_ON_BOX =
  "not checked at the install on the person's Mac, so not loaded on this box: a box starts a source's server only once the Mac's install signed it in and its one read passed (abe install there runs it again).";

/**
 * Why a source did not load on a box (3.2.1): a box's session loads a source only from the repo's
 * `sources:` with its definition, the Mac's synced `abe.yaml`; a bare name there is a server of
 * the person's Claude Code on their Mac, which no box has.
 */
const NOT_ON_BOX = `not loaded on this box: a box's session loads a source only from the repo's ${REPO_PATH} sources: with its definition (abe install source <name> writes a bare name's), never from a repo's .mcp.json, and a claude.ai connector does not load on a box.`;

/**
 * What a Factory run on this Mac (`mac`) or a box's session (`box`) is told of the repo's
 * `sources`, `missing` those that did not load (`SourcesLoaded.missing`): one line naming only
 * those that loaded (`sourcesLine`), then which did not, and why. None without sources.
 */
export const sourcesTold = (o: {
  sources: readonly string[];
  missing: readonly string[];
  /** Of `missing`, those whose definition holds a value (`SourceServers.withheld`). */
  withheld?: readonly string[];
  /** Of `missing`, those no install check passed for (`checkedSourceServers`). */
  unchecked?: readonly string[];
  local: boolean;
  where: 'mac' | 'box';
}): string | null => {
  const line = sourcesLine(o.sources);

  if (line === null || o.missing.length === 0) return line;
  const loaded = sourcesLine(o.sources.filter((s) => !o.missing.includes(s)));
  const withheld = o.missing.filter((s) => o.withheld?.includes(s) === true);
  const unchecked = o.missing.filter(
    (s) => !withheld.includes(s) && o.unchecked?.includes(s) === true,
  );
  const absent = o.missing.filter((s) => !withheld.includes(s) && !unchecked.includes(s));
  const said = (names: string[], why: string) =>
    names.length === 0 ? [] : [`${listed(names)} ${names.length === 1 ? 'is' : 'are'} ${why}`];
  const not = [
    ...said(absent, o.where === 'mac' ? NOT_IN_RUN : NOT_ON_BOX),
    ...said(unchecked, o.where === 'mac' ? NOT_CHECKED : NOT_CHECKED_ON_BOX),
    ...said(withheld, WITHHELD),
    AFTER,
  ].join(' ');

  return loaded === null ? `Sources: this repo's ${not}` : `${loaded} ${not}`;
};

/** `instructions` with what the session is told of its `sources` after them (`sourcesTold`). */
export const withSourcesTold = (
  instructions: string,
  sources:
    | {
        names: readonly string[];
        local: boolean;
        withheld?: readonly string[];
        unchecked?: readonly string[];
      }
    | undefined,
  missing: readonly string[],
  where: 'mac' | 'box',
): string => {
  const told =
    sources === undefined
      ? null
      : sourcesTold({
          sources: sources.names,
          missing,
          ...(sources.withheld === undefined ? {} : { withheld: sources.withheld }),
          ...(sources.unchecked === undefined ? {} : { unchecked: sources.unchecked }),
          local: sources.local,
          where,
        });

  return told === null ? instructions : `${instructions}\n\n${told}`;
};
