import { describe, expect, test } from 'bun:test';
import { until } from './until';

describe('until', () => {
  test('the first value check gives', async () => {
    let n = 0;

    expect(await until('three', () => (++n >= 3 ? n : undefined), { every: 1 })).toBe(3);
  });

  test('false and 0 are values, and only undefined waits', async () => {
    expect(await until('false', () => false)).toBe(false);
    expect(await until('zero', () => Promise.resolve(0))).toBe(0);
  });

  test('past its time it fails, saying what it waited for and last saw', async () => {
    let last = 0;

    const failed = await until(
      () => `the count: still ${last}`,
      () => {
        last += 1;

        return undefined;
      },
      { ms: 20, every: 5 },
    ).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(Error);
    expect(failed instanceof Error && failed.message).toMatch(
      /^timed out waiting for the count: still \d+$/,
    );
  });
});
