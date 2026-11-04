/**
 * A source's tools (spec 3.0.1, ADR 0029): every tool of every added source is allowed, writes
 * too, in a session (`accessRules`, `agent-envs.ts`) and in the install's source probe
 * (`sourceRules`): Abe blocks no MCP call. Here too the session's sign-in tools, which serve runs
 * instead. The servers are the person's own, logged in their own way: no token here. No imports:
 * the hook loads it for an MCP tool's call.
 */

/** A server's name as Claude Code writes it in a tool's name: `.` and other characters as `_`. */
const serverName = (source: string) => source.replace(/[^A-Za-z0-9_-]/g, '_');

/** The install's source probe's permission rules (`sourceAccountSettings`): every tool of each source allowed. */
export const sourceRules = (sources: readonly string[]): { allow: string[]; deny: string[] } => ({
  allow: sources.map((s) => `mcp__${serverName(s)}__*`),
  deny: [],
});

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

/** The line a session's instructions get about the repo's sources; none without sources. */
export const sourcesLine = (sources: readonly string[]): string | null =>
  sources.length === 0
    ? null
    : `Sources: this repo also reads ${listed(sources)} through their MCP servers. Every tool of theirs is allowed, writes too.`;

/**
 * Claude Code's own tools that start a source's sign-in in a session (on a server that needs one):
 * a session never runs them. The sign-in is the person's, run by serve outside any sandbox
 * (`abe source sign-in`: the install's session for them, or Settings' Sign in).
 */
export const SIGN_IN_TOOLS = ['authenticate', 'complete_authentication'] as const;

/**
 * A session's variable for its hook when its MCP servers are Abe's and the repo's sources alone (a
 * card's, the install's, a box's): Claude Code's sign-in tools refused (`signInToolRefusal`), the
 * person pointed at where they sign in: `install` (the install's own session: `abe source sign-in`)
 * or `settings` (Settings › Logins & tools). Not in a chat of the person's own, whose servers are
 * theirs. Not an `ABE_*` name: those are redacted.
 */
export const SIGN_IN_ON_PAGE_ENV = 'SIGN_IN_ON_PAGE_BY_ABE';

/** Where the person signs in to a source: through the install's session while it installs, else Settings. */
export type SignInPage = 'install' | 'settings';

const SIGN_IN_WHERE: Readonly<Record<SignInPage, string>> = {
  install: "the install's own session runs abe source sign-in for them",
  settings: 'use Sign in on its row in Settings › Logins & tools',
};

/** What a session is told when it tries to start `source`'s sign-in (`''`: a source's). */
export const signInRefusalWords = (source: string, page: SignInPage = 'install'): string =>
  `${source === '' ? "A source's" : `${source}'s`} sign-in is the person's: ${SIGN_IN_WHERE[page]} (serve runs it in their browser, outside any sandbox). ${page === 'install' ? "Never Claude Code's own sign-in tool" : 'A session never starts one'}`;

/**
 * Why the hook refuses `tool` (a PreToolUse's `tool_name`): it starts a sign-in; `page` where the
 * person signs in instead (`SIGN_IN_ON_PAGE_ENV`'s value). Null: it goes on.
 */
export const signInToolRefusal = (tool: string, page: SignInPage = 'install'): string | null => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);

  if (m === null) return null;
  const [, server = '', name = ''] = m;

  return SIGN_IN_TOOLS.some((t) => t === name)
    ? `${tool} refused: ${signInRefusalWords(server, page)}.`
    : null;
};
