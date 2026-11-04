/**
 * How a box looks on every screen: the 12 px cloud's three states, the rail row's box mark
 * (a cloud, or Queued), and the `box.state` moves a screen keeps by box name. One type each, used
 * by the components, the Board, Chat's header, Sessions and the context line.
 */
import type { EventData } from '@abe/core';

/** A box's cloud: filled while it runs, dashed while it starts, an outline asleep. */
export const CLOUD_STATES = ['running', 'asleep', 'starting'] as const;
export type CloudState = (typeof CLOUD_STATES)[number];

/**
 * The box mark on a card's rail row and a session's Where cell: its cloud, or Queued (a placement
 * waiting for room: the outline, `☁ Queued` dim).
 */
export const BOX_MARKS = [...CLOUD_STATES, 'queued'] as const;
export type BoxMark = (typeof BOX_MARKS)[number];

/** A box mark's cloud: Queued waits asleep. */
export const CLOUD_OF: Readonly<Record<BoxMark, CloudState>> = {
  running: 'running',
  starting: 'starting',
  asleep: 'asleep',
  queued: 'asleep',
};

/** What a box did, as `box.state` says it (core's `BOX_MOVES`). */
export type BoxMove = EventData<'box.state'>['state'];

/** The last `box.state` move of each box a screen heard of, by the box's name. */
export type BoxMoves = Readonly<Record<string, BoxMove>>;
