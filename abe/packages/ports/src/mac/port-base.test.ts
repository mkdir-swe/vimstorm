import { describe, expect, test } from 'bun:test';
import { PORT_RANGE } from '@abe/core';
import { freePortBase, loopbackFree } from './port-base';

describe("a pack script's port base (#349)", () => {
  test('the first base whose ten ports are free and no one else holds; the one it had first', () => {
    const first = PORT_RANGE.first;
    const taken = new Set([first + 3]);
    const free = (p: number) => !taken.has(p);

    expect(freePortBase(new Set(), undefined, free)).toBe(first + 10);
    expect(freePortBase(new Set([first + 10]), undefined, free)).toBe(first + 20);
    expect(freePortBase(new Set(), first + 50, free)).toBe(first + 50);
    expect(freePortBase(new Set(), undefined, () => false)).toBeUndefined();
  });

  test('a port someone listens on is not free', () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });

    expect(loopbackFree(server.port)).toBe(false);
    server.stop(true);
    expect(loopbackFree(server.port)).toBe(true);
  });
});
