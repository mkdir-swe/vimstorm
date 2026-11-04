/** A source's headless sign-in (ADR 0027): the lines it sends and how it reads Claude Code's. */
import { expect, test } from 'bun:test';
import {
  type ControlLine,
  mcpAuthenticateLine,
  mcpStateOfStatus,
  mcpStatusLine,
  readControlLine,
} from './source-sign-in';
import { type McpState } from './install-connection';

const answer = (response: unknown) =>
  JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'a1', response },
  });

test.each<[string, string, ControlLine | null]>([
  [
    'the sign-in URL',
    answer({ authUrl: 'https://auth.example.com/authorize?x=1', callbackPort: 54321 }),
    { id: 'a1', kind: 'auth', authUrl: 'https://auth.example.com/authorize?x=1' },
  ],
  [
    "each server's state, a list",
    answer([{ name: 'sentry', status: 'connected' }]),
    { id: 'a1', kind: 'status', servers: [{ name: 'sentry', status: 'connected' }] },
  ],
  [
    "each server's state, under mcpServers",
    answer({ mcpServers: [{ name: 'sentry', status: 'needs-auth' }] }),
    { id: 'a1', kind: 'status', servers: [{ name: 'sentry', status: 'needs-auth' }] },
  ],
  [
    'a request Claude Code does not know: the person updates it, then signs in again',
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'a1',
        error: 'Unsupported control request subtype: mcp_authenticate',
      },
    }),
    { id: 'a1', kind: 'unsupported' },
  ],
  [
    'another error: said',
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'a1', error: 'no server sentry' },
    }),
    { id: 'a1', kind: 'error', message: 'no server sentry' },
  ],
  ['a line of the session itself: none', JSON.stringify({ type: 'system', subtype: 'init' }), null],
  ['no JSON: none', 'Loading…', null],
])('a line read: %s', (_, line, want) => {
  expect(readControlLine(line)).toEqual(want);
});

test.each<[string | undefined, McpState]>([
  ['connected', 'connected'],
  ['needs-auth', 'needs-auth'],
  ['pending', 'needs-auth'],
  ['failed', 'failed'],
  [undefined, 'none'],
])('mcp_status %s reads as %s', (status, state) => {
  expect(mcpStateOfStatus(status)).toBe(state);
});

test('the lines sent: one control request each, names only', () => {
  expect(JSON.parse(mcpAuthenticateLine('a1', 'sentry'))).toEqual({
    type: 'control_request',
    request_id: 'a1',
    request: { subtype: 'mcp_authenticate', serverName: 'sentry' },
  });
  expect(JSON.parse(mcpStatusLine('s1'))).toEqual({
    type: 'control_request',
    request_id: 's1',
    request: { subtype: 'mcp_status' },
  });
});
