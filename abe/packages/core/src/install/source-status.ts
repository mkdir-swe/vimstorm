/**
 * A repo's sources as their rows say them, on the install page while it installs and in Settings ›
 * Logins & tools after (ADR 0028): each source's server's state, its one read once serve signed
 * it in, and its Sign in (serve runs it in the person's browser, outside any sandbox; `abe source
 * sign-in`). Pure: the words; serve reads the states.
 */
import { z } from 'zod';
import { type McpState } from './install-connection';
import { type SourceProbeRead } from './source-sign-in';

/**
 * A source's check: its server's state, its one read once connected (null: not read), why not;
 * `signIn` false: it has no sign-in known (none told: one serve ran from Settings has one).
 */
export type SourceCheck = {
  mcp: McpState;
  probe: SourceProbeRead | null;
  why: string | null;
  signIn?: boolean;
};

/** What a source's row says while serve signs it in. */
export const SIGNING_IN = 'Signing in…';

/** A no-sign-in source's one read, as its row says it after `Answers ·`. */
const NO_SIGN_IN_READ: Readonly<Record<SourceProbeRead, string>> = {
  ok: 'read OK',
  'tool-error': 'read failed',
  timeout: 'read: no answer in time',
};

/** A source's check as its row says it, its sign-in while serve runs it; null: not checked. */
export const sourceCheckWords = (c: SourceCheck | undefined, signing: boolean): string | null => {
  if (signing) return SIGNING_IN;
  if (c === undefined) return null;
  if (c.mcp === 'needs-auth')
    return c.why === null ? 'needs your sign-in' : `sign-in failed: ${c.why}`;
  if (c.mcp === 'failed') return 'its server does not answer';
  if (c.mcp === 'none') return 'no server here';
  // none to sign in to: its server answers, signed in it is not
  if (c.signIn === false)
    return `Answers · ${c.probe === null ? 'no sign-in' : NO_SIGN_IN_READ[c.probe]}`;
  if (c.probe === null) return 'Signed in';
  if (c.probe === 'tool-error') return 'Connected · its one read gave an error';
  if (c.probe === 'timeout') return 'Signed in · read: no answer in time';

  return 'Signed in · read OK';
};

/** Whether Sign in helps a source: its server needs a sign-in, or another account's (it has one). */
export const sourceSignInHelps = (c: SourceCheck | undefined): boolean =>
  c?.mcp === 'needs-auth' ||
  (c?.mcp === 'connected' && c.probe === 'tool-error' && c.signIn !== false);

/** One source of a checkout, as `abe source status` answers it. */
export const SourceStatus = z.object({
  /** The source, as the repo's `sources:` and the install name it. */
  id: z.string(),
  /** Its MCP server in this checkout's Claude Code. */
  server: z.string(),
  /** What its row says: Signing in…, Signed in · read OK, or what stops it. */
  check: z.string(),
  /** `signing-in`: serve runs its sign-in now; `offered`: Sign in would help; null: neither. */
  signIn: z.enum(['signing-in', 'offered']).nullable(),
  /** Signed in, its one read ok. */
  reads: z.boolean(),
});
export type SourceStatus = z.infer<typeof SourceStatus>;

/** A main checkout's sources (`abe source status`, `abe source sign-in`, `sources.changed`). */
export const SourcesData = z.object({ repo: z.string(), sources: z.array(SourceStatus) });
export type SourcesData = z.infer<typeof SourcesData>;

/** A source's row from its check and whether serve signs it in now. */
export const sourceStatus = (o: {
  id: string;
  server: string;
  check: SourceCheck | undefined;
  signing: boolean;
}): SourceStatus => {
  const offered = sourceSignInHelps(o.check) ? 'offered' : null;

  return {
    id: o.id,
    server: o.server,
    check: sourceCheckWords(o.check, o.signing) ?? 'not checked',
    signIn: o.signing ? 'signing-in' : offered,
    reads: !o.signing && o.check?.mcp === 'connected' && o.check.probe === 'ok',
  };
};

/** `abe source status` as text: one line per source. */
export const sourcesText = (d: SourcesData): string =>
  d.sources.length === 0
    ? `${d.repo}: no sources\n`
    : d.sources.map((x) => `${x.id} (${x.server}): ${x.check}\n`).join('');
