/**
 * The hook's own minimal socket client: it imports only the contract's types, so `abe hook`
 * starts fast. It gives up after its deadline and never throws: a hiccup in Abe never stalls
 * Claude Code.
 */
import { createConnection } from 'node:net';
import { type Request } from '@abe/core';

export type Forwarded = 'answered' | 'unreachable' | 'timeout';

export const forward = (
  socket: string,
  request: Omit<Request, 'v'>,
  timeoutMs = 1000,
  /** The reply's line, once it came whole. */
  onReply?: (line: string) => void,
): Promise<Forwarded> =>
  new Promise((resolve) => {
    const conn = createConnection(socket);
    const done = (how: Forwarded) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(how);
    };
    const timer = setTimeout(() => {
      done('timeout');
    }, timeoutMs);
    const frame: Request = { v: 1, ...request };

    let got = '';

    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(frame)}\n`));
    conn.on('data', (chunk: string) => {
      got += chunk;
      const end = got.indexOf('\n');

      if (end !== -1) {
        onReply?.(got.slice(0, end));
        done('answered');
      }
    });
    conn.on('end', () => {
      done('answered');
    });
    conn.on('error', () => {
      done('unreachable');
    });
  });
