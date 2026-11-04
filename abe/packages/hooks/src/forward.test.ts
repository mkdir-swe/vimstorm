import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { scenario, tempState } from '@abe/testing';
import { forward } from './forward';

describe('forward', () => {
  test('a serve that answers', async () => {
    await using s = await scenario();

    expect(await forward(s.state.socket, { argv: ['status'], cwd: '/' })).toBe('answered');
  });

  test('no serve: unreachable, at once', async () => {
    const state = tempState();

    expect(await forward(state.socket, { argv: ['status'], cwd: '/' })).toBe('unreachable');
    state.remove();
  });

  test('a serve that never answers: gives up at the deadline', async () => {
    const state = tempState();
    const silent = createServer(() => undefined);

    await new Promise<void>((resolve) => silent.listen(state.socket, resolve));
    const before = Date.now();

    expect(await forward(state.socket, { argv: ['status'], cwd: '/' }, 100)).toBe('timeout');
    expect(Date.now() - before).toBeLessThan(1000);
    silent.close();
    state.remove();
  });
});
