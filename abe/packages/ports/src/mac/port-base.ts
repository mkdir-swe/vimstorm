/**
 * A pack script's port base (#349): the first of `PORT_SPAN` loopback ports no one listens on and
 * no other prototype or session of this `serve` holds, handed to it as `ABE_PORT_BASE`. IO only.
 */
import { PORT_RANGE, PORT_SPAN } from '@abe/core';

/** Whether a loopback port can be listened on now. */
export const loopbackFree = (port: number): boolean => {
  try {
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => undefined } });

    server.stop(true);

    return true;
  } catch {
    return false;
  }
};

/**
 * A base whose `PORT_SPAN` ports are all free, `want` first (the one it had before), then the
 * range in order, skipping every base in `held`; undefined when the range is full.
 */
export const freePortBase = (
  held: ReadonlySet<number>,
  want?: number,
  free: (port: number) => boolean = loopbackFree,
): number | undefined => {
  const fits = (base: number) =>
    !held.has(base) && Array.from({ length: PORT_SPAN }, (_, i) => base + i).every(free);

  if (want !== undefined && fits(want)) return want;
  const count = Math.floor((PORT_RANGE.last - PORT_RANGE.first) / PORT_SPAN) + 1;

  return Array.from({ length: count }, (_, i) => PORT_RANGE.first + i * PORT_SPAN).find(fits);
};
