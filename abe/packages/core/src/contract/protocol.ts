/** The socket's frames: one request line in, one reply line out. */
import { z } from 'zod';
import { EXIT, type Printed } from '../command';
import { PROTOCOL, type Reply, Request } from './contract';

export const toReply = (printed: Printed): Reply => ({ v: PROTOCOL, ...printed });

const refusal = (code: string, message: string, json: boolean): Reply => ({
  v: PROTOCOL,
  exit: EXIT.failed,
  stdout: json ? `${JSON.stringify({ ok: false, error: { code, message } })}\n` : '',
  stderr: json ? '' : `abe: ${message}\n`,
  error: { code, message },
});

const Versioned = z.object({ v: z.unknown().optional(), argv: z.unknown().optional() });

/**
 * One request line read: the request, or the reply that refuses it. Any `v` but this build's is
 * `unsupported-version`, so a newer client hears why instead of a parse error.
 */
export const readRequest = (
  text: string,
): { ok: true; request: Request } | { ok: false; reply: Reply } => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reply: refusal('bad-request', 'the request is not JSON', false) };
  }
  const versioned = Versioned.safeParse(doc);
  const argv = versioned.data?.argv;
  const json = Array.isArray(argv) && argv.includes('--json');

  if (!versioned.success)
    return { ok: false, reply: refusal('bad-request', 'the request is not an object', json) };
  if (versioned.data.v !== PROTOCOL) {
    const asked = versioned.data.v === undefined ? 'none' : JSON.stringify(versioned.data.v);
    const why = `protocol version ${asked} is not supported; this abe serve speaks ${PROTOCOL}`;

    return { ok: false, reply: refusal('unsupported-version', why, json) };
  }
  const request = Request.safeParse(doc);

  if (!request.success) {
    const why = `the request does not match {"v":1,"argv":[…],"cwd":"…"}: ${request.error.message}`;

    return { ok: false, reply: refusal('bad-request', why, json) };
  }

  return { ok: true, request: request.data };
};
