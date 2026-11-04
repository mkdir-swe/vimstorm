/**
 * The port bases this `serve` holds (#349): one per running prototype and per local session,
 * each the first of `PORT_SPAN` free loopback ports (`ABE_PORT_BASE`), never one another holds.
 */
import { freePortBase, loopbackFree } from '@abe/ports';

export type PortBases = {
  /** `key`'s base: the one it holds, else `want` when free, else the first free one. */
  take: (key: string, want?: number) => number | undefined;
  /** `key` lets its base go. */
  release: (key: string) => void;
};

export const openPortBases = (free: (port: number) => boolean = loopbackFree): PortBases => {
  const held = new Map<string, number>();

  return {
    take: (key, want) => {
      const had = held.get(key);

      if (had !== undefined) return had;
      const others = new Set(held.values());
      const base = freePortBase(others, want, free);

      if (base !== undefined) held.set(key, base);

      return base;
    },
    release: (key) => {
      held.delete(key);
    },
  };
};
