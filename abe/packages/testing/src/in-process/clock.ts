import { type Clock } from '@abe/core';

/** 2026-10-01 09:00 UTC, the moment every scenario starts at. */
export const T0 = 1_790_845_200_000;

export type FakeClock = Clock & { tick: (ms: number) => void };

export const fakeClock = (start = T0): FakeClock => {
  let now = start;

  return {
    now: () => now,
    tick: (ms) => {
      now += ms;
    },
  };
};

/**
 * This machine's time, which `tick` moves on. For a serve that must run as the real one does, as in
 * `cli()`.
 */
export const wallClock = (): FakeClock => {
  let ahead = 0;

  return {
    now: () => Date.now() + ahead,
    tick: (ms) => {
      ahead += ms;
    },
  };
};
