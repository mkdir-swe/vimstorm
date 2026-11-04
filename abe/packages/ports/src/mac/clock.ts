import { type Clock } from '@abe/core';

export const systemClock: Clock = { now: () => Date.now() };

/** The first local midnight after `ms` (this machine's time zone): when a Done run clears. */
export const nextLocalMidnight = (ms: number): number => {
  const day = new Date(ms);

  day.setHours(24, 0, 0, 0);

  return day.getTime();
};
