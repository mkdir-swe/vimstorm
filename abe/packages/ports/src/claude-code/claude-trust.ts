/**
 * Claude Code's folder trust: an interactive `claude` in a folder its config has not trusted
 * shows the trust dialog before anything else, before any hook, so a session nobody attached to
 * would sit there. For a worktree Abe itself made, the session runner sets what accepting that
 * dialog sets: `projects[<path>].hasTrustDialogAccepted: true` in Claude Code's own config
 * (`<home>/.claude.json`, the file Claude Code's message about it names). Nothing else in the file
 * changes, and no other folder is trusted: permissions stay as they are.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpServerNames } from '@abe/core';
import { z } from 'zod';

/** Claude Code's config as far as trust goes; every other key is kept as it was. */
const Config = z.looseObject({
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

/** Claude Code's config file for a session with this `HOME` (it is given no `CLAUDE_CONFIG_DIR`). */
export const claudeConfigFile = (home: string): string => join(home, '.claude.json');

const forms = (path: string) => {
  try {
    return [...new Set([path, realpathSync(path)])];
  } catch {
    return [path];
  }
};

/**
 * Marks `folder` (as given and its real path) trusted in `<home>/.claude.json`, written through a
 * rename. A folder trusted already leaves the file untouched; a file that is not Claude Code's
 * JSON is never overwritten (the dialog then shows, and the person answers it).
 */
export const trustFolder = (
  home: string,
  folder: string,
): { ok: true; written: boolean } | { ok: false; message: string } => {
  const file = claudeConfigFile(home);
  let doc: unknown = {};

  if (existsSync(file))
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { ok: false, message: `${file} is not JSON; not touched` };
    }
  const config = Config.safeParse(doc);

  if (!config.success)
    return { ok: false, message: `${file} is not Claude Code's config; not touched` };
  const projects = config.data.projects ?? {};
  const paths = forms(folder);

  const kept = (p: string) => projects[p]?.hasTrustDialogAccepted === true;

  if (paths.every(kept)) return { ok: true, written: false };
  const next = {
    ...config.data,
    projects: {
      ...projects,
      ...Object.fromEntries(
        paths.map((p) => [p, { ...projects[p], hasTrustDialogAccepted: true }]),
      ),
    },
  };
  // Through a link (a dotfile manager's) to the file itself, so the link stays a link.
  const target = existsSync(file) ? realpathSync(file) : file;
  const temp = `${target}.abe-${process.pid}`;

  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });

    return { ok: false, message: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ok: true, written: true };
};

/** Claude Code's config as far as MCP servers go: `mcpServers`, a record of them. */
const McpServers = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()) });

/**
 * The person's Claude Code config (`<home>/.claude.json`) when it names MCP servers, for a
 * session's `--mcp-config` (`session.mcp: yours` with `skillsOnTop` off, whose setting sources
 * leave the user's servers out). The file itself, never a copy: its servers' env may hold tokens,
 * and Abe writes no second file of them. Claude Code refuses an
 * `--mcp-config` without `mcpServers`, so none is named then.
 */
export const personalMcpConfig = (home: string): string | undefined => {
  const file = claudeConfigFile(home);

  try {
    const doc = McpServers.safeParse(JSON.parse(readFileSync(file, 'utf8')));

    return doc.success && Object.keys(doc.data.mcpServers).length > 0 ? file : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Of the person's own MCP servers (`<home>/.claude.json`'s `mcpServers`), those `pick` names, by
 * name with their definitions, for the config Abe generates for a session whose servers are
 * otherwise Abe's (a prototype session's Figma server). None: no config, or none picked.
 */
export const personalServers = (
  home: string,
  pick: (servers: Readonly<Record<string, unknown>>) => readonly string[],
): Record<string, unknown> => {
  try {
    const doc = McpServers.safeParse(JSON.parse(readFileSync(claudeConfigFile(home), 'utf8')));

    if (!doc.success) return {};
    const all = doc.data.mcpServers;

    return Object.fromEntries(pick(all).flatMap((n) => (n in all ? [[n, all[n]]] : [])));
  } catch {
    return {};
  }
};

/** The MCP server names an MCP config file has (`mcpServerNames`); none when it is not there. */
export const mcpServerNamesIn = (file: string): string[] => {
  try {
    return mcpServerNames(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
};

/**
 * The first of `files` (Claude Code's MCP config files) whose `mcpServers` names `name`, for an
 * `--mcp-config` of that one file. Only the names are read; nothing of the file is said.
 */
export const mcpConfigNaming = (name: string, files: readonly string[]): string | undefined =>
  files.find((file) => mcpServerNamesIn(file).includes(name));

const Scopes = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  projects: z
    .record(z.string(), z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() }))
    .optional(),
});

/**
 * The MCP server names a session in the checkout `top` loads (ADR 0027): its local scope in
 * `<home>/.claude.json` (`projects[<top>]`, as given and real), then the user scope's. Names only.
 */
export const mcpServersHere = (home: string, top: string): string[] => {
  try {
    const doc = Scopes.safeParse(JSON.parse(readFileSync(claudeConfigFile(home), 'utf8')));

    if (!doc.success) return [];
    const local = forms(top).flatMap((p) => Object.keys(doc.data.projects?.[p]?.mcpServers ?? {}));

    return [...new Set([...local, ...Object.keys(doc.data.mcpServers ?? {})])];
  } catch {
    return [];
  }
};
