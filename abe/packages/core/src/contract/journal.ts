/**
 * A `serve`'s events: numbered from 1, stamped by the clock, the last `RING` held for watchers
 * that resume with `--since`, and every new one handed to each watcher.
 */
import { Event, type EventData, type EventType } from './events';
import { type ExitCode } from '../command';
import { type Clock } from '../ports';
import { COMMANDS } from './commands';
import { parse } from './parse';

/** How many recent events `--since` can replay. */
export const RING = 10_000;

export type Journal = {
  /**
   * Checks `data` against the type's row (and the type against the table), numbers and keeps it;
   * `box` tags one a box's own `serve` sent (merged into this one's stream).
   */
  emit: <T extends EventType>(type: T, data: EventData<T>, box?: string) => Event;
  /**
   * Hands `see` the held events after `since` (a `watch.gap` first when some are gone, or when
   * `since` is ahead of this journal), then every new one, until the returned stop is called. With
   * no `since` only new ones. A `see` that throws is dropped.
   */
  watch: (since: number | undefined, see: (event: Event) => void) => () => void;
  /** The number of the newest event, 0 before any. */
  last: () => number;
  /** How many are watching. */
  watchers: () => number;
};

export const journal = (clock: Clock, size = RING): Journal => {
  const held: Event[] = [];
  const watching = new Set<(event: Event) => void>();
  let last = 0;

  const stamp = () => new Date(clock.now()).toISOString();

  const hand = (see: (event: Event) => void, event: Event) => {
    try {
      see(event);
    } catch {
      watching.delete(see);
    }
  };

  const emit: Journal['emit'] = (type, data, box) => {
    const parsed = Event.safeParse({
      seq: last + 1,
      at: stamp(),
      type,
      data,
      ...(box === undefined ? {} : { box }),
    });

    if (!parsed.success)
      throw new Error(`${type} is not an event abe knows with that data: ${parsed.error.message}`);
    last += 1;
    held.push(parsed.data);
    // Trimmed in batches, so a full ring costs no copy per event.
    if (held.length >= size * 2) held.splice(0, held.length - size);
    for (const see of [...watching]) hand(see, parsed.data);

    return parsed.data;
  };

  const replay = (since: number, see: (event: Event) => void) => {
    const ring = held.slice(-size);
    const first = ring[0]?.seq ?? last + 1;

    if (since < first - 1 || since > last) {
      const gap = Event.parse({
        seq: first - 1,
        at: stamp(),
        type: 'watch.gap',
        data: { since, first },
      });

      hand(see, gap);
    }
    for (const event of ring) {
      if (!watching.has(see)) return;
      if (event.seq > since || since > last) hand(see, event);
    }
  };

  return {
    emit,
    watch: (since, see) => {
      watching.add(see);
      if (since !== undefined) replay(since, see);

      return () => {
        watching.delete(see);
      };
    },
    last: () => last,
    watchers: () => watching.size,
  };
};

/**
 * `command.ran` for argv answered with `exit`, with the request's `tag` when it had one; argv
 * naming no command is no command.
 */
export const commandRan = (
  events: Journal,
  argv: readonly string[],
  exit: ExitCode,
  tag?: string,
) => {
  const { id } = parse(argv);

  if (id === undefined) return;
  const def = COMMANDS[id];

  events.emit('command.ran', {
    noun: def.noun,
    verb: def.verb ?? null,
    exit,
    ...(tag === undefined ? {} : { tag }),
  });
};
