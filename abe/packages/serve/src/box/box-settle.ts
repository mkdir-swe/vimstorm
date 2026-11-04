/**
 * The one wait for a box (ADR 0021): EC2 read again every `pollMs` until it says the box is up or
 * down, by core's `boxSettling` (a launch, a wake, `box up`, `box stop`, a resize, `box attach`'s
 * wake all wait through it), and a sleeping box started on the way.
 */
import {
  type Answered,
  type Box,
  type Boxes,
  boxSettling,
  canStart,
  type Outcome,
  refused,
} from '@abe/core';

export type SettleDeps = {
  boxes: Boxes;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
};

/** A port's refusal as a handler's. */
export const failedOf = (a: { error: { code: string; message: string } }) =>
  refused(a.error.code, a.error.message);

/**
 * Waits until EC2 says the box is `want`, until the clock passes `until` (`box-timeout`); a box
 * that never gets there is `box-failed`. `fresh`: just made, so not listed yet is not gone.
 */
export const settleBox = async (
  d: SettleDeps,
  name: string,
  want: 'running' | 'stopped',
  until: number,
  fresh = false,
): Promise<Outcome<Box>> => {
  const began = d.now();

  for (;;) {
    const read = await d.boxes.status(name);

    if (!read.ok) return failedOf(read);
    const settling = boxSettling(want, read.data?.state ?? null, fresh);

    if (settling.kind === 'there' && read.data !== null) return { ok: true, data: read.data };
    if (settling.kind === 'failed') return refused('box-failed', `box ${name} ${settling.why}`);
    if (d.now() > until)
      return refused(
        'box-timeout',
        `box ${name} is not ${want} after ${Math.round((until - began) / 1000)} s`,
      );
    await d.sleep(d.pollMs);
  }
};

/**
 * The box running: a stop in progress waited for first, a stopped one started, one up or coming
 * already (someone woke it meanwhile) waited for as it is.
 */
export const startBox = async (
  d: SettleDeps,
  name: string,
  until: number,
  /** The box as EC2 was just read (not read again). */
  known?: Box,
): Promise<Outcome<Box>> => {
  const read: Answered<Box | null> =
    known === undefined ? await d.boxes.status(name) : { ok: true, data: known };

  if (!read.ok) return failedOf(read);
  if (read.data === null)
    return refused('no-box', `you have no box ${name}: abe box list names yours`);
  let state = read.data.state;

  if (state === 'stopping') {
    const down = await settleBox(d, name, 'stopped', until);

    if (!down.ok) return down;
    state = down.data.state;
  }
  if (canStart(state)) {
    const asked = await d.boxes.start(name);

    if (!asked.ok) return failedOf(asked);
  }

  return settleBox(d, name, 'running', until);
};
