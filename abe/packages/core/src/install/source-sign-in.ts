/**
 * A source's sign-in (ADR 0027, the i3-1 spike on #53): Claude Code's own MCP OAuth, started with
 * no TTY and no model call. Serve runs a headless `claude -p` in stream-json on a generated MCP
 * config of that one server, asks it `mcp_authenticate` (a control request Claude Code does not
 * document), opens the URL it answers in the person's browser, and polls `mcp_status` until the
 * server reads `connected`. The token goes straight into Claude Code's store: it never passes
 * through Abe, and the URL is never logged. When Claude Code does not know the request, the
 * person updates it and signs in again: the install's session never starts a sign-in. Pure: the
 * argv, the lines, reading them.
 */
import { z } from 'zod';
import { type McpState } from './install-connection';

/** How long the person has to sign in, in their browser, before serve stops waiting. */
export const SOURCE_SIGN_IN_TIMEOUT_MS = 300_000;

/** How often `mcp_status` is asked while the person signs in. */
export const SOURCE_SIGN_IN_POLL_MS = 2_000;

/** What the person does when the headless sign-in is not there (an older Claude Code). */
export const SIGN_IN_FALLBACK =
  'Claude Code here has no headless sign-in: update it (claude update), then Sign in again';

/** A sign-in's end: signed in, or why not (`fallback`: Claude Code here can't run it headless). */
export type SignInResult = { signedIn: true } | { signedIn: false; why: string; fallback: boolean };

/** The headless `claude` the sign-in talks to: no prompt, stream-json both ways, only `config`'s server. */
export const signInArgv = (o: { claude: string; config: string }): string[] => [
  o.claude,
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--mcp-config',
  o.config,
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence',
];

const request = (id: string, body: Record<string, string>) =>
  `${JSON.stringify({ type: 'control_request', request_id: id, request: body })}\n`;

/** The line that starts a server's sign-in: Claude Code answers its `authUrl`. */
export const mcpAuthenticateLine = (id: string, server: string): string =>
  request(id, { subtype: 'mcp_authenticate', serverName: server });

/** The line that asks every server's state (`connected`, `needs-auth`, `failed`), no tokens. */
export const mcpStatusLine = (id: string): string => request(id, { subtype: 'mcp_status' });

const Response = z.looseObject({
  type: z.literal('control_response'),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    error: z.string().optional(),
    response: z.unknown().optional(),
  }),
});
const Auth = z.looseObject({ authUrl: z.string() });
const Status = z.looseObject({
  mcpServers: z.array(z.looseObject({ name: z.string(), status: z.string() })),
});
const Statuses = z.array(z.looseObject({ name: z.string(), status: z.string() }));

/** One line Claude Code wrote, as far as the sign-in reads it; null: none of its answers. */
export type ControlLine =
  | { id: string; kind: 'auth'; authUrl: string }
  | { id: string; kind: 'status'; servers: { name: string; status: string }[] }
  | { id: string; kind: 'unsupported' }
  | { id: string; kind: 'error'; message: string };

const json = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** A stream-json line read: a control request's answer, or null. */
export const readControlLine = (line: string): ControlLine | null => {
  const r = Response.safeParse(json(line));

  if (!r.success) return null;
  const { request_id: id, subtype, error, response } = r.data.response;

  if (subtype === 'error' || error !== undefined) {
    const message = error ?? 'failed';

    return /unsupported control request/i.test(message)
      ? { id, kind: 'unsupported' }
      : { id, kind: 'error', message };
  }
  const auth = Auth.safeParse(response);

  if (auth.success) return { id, kind: 'auth', authUrl: auth.data.authUrl };
  const status = Status.safeParse(response);

  if (status.success) return { id, kind: 'status', servers: status.data.mcpServers };
  const list = Statuses.safeParse(response);

  return list.success ? { id, kind: 'status', servers: list.data } : null;
};

/** A server's state as `mcp_status` words it, in the install's words. */
export const mcpStateOfStatus = (status: string | undefined): McpState => {
  if (status === 'connected') return 'connected';
  if (status === 'needs-auth' || status === 'pending') return 'needs-auth';

  return status === undefined ? 'none' : 'failed';
};

/**
 * A source's probe after it is signed in: one reading tool call returned without error (`ok`),
 * the tool said an error (`tool-error`: the account can't read), or no answer in time
 * (`timeout`); and the account it told, as far as it did.
 */
export const SourceProbeRead = z.enum(['ok', 'tool-error', 'timeout']);
export type SourceProbeRead = z.infer<typeof SourceProbeRead>;
