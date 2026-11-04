/**
 * `abe box resize <box> <size>` (#59, #90) from the Mac: the box's size is its EC2 instance
 * type, so a resize stops the box, changes its type (`Boxes.resize`) and starts it again; a
 * sleeping box starts at its new size. The size must be within the team's `limits.maxBoxSize`;
 * sessions running on the box (the box's own `abe session list`, and this `serve`'s launches
 * there) end with the stop, so then it needs `--yes`.
 */
import {
  type Box,
  type Boxes,
  type BoxLink,
  type BoxResizeData,
  type BoxState,
  canStart,
  type Envelope,
  holdsBox,
  type Ran,
  type Clock,
  coreDefaults,
  type Outcome,
  readEnvelope,
  refused,
  resizeRefusal,
  SessionListData,
  type Handlers,
} from '@abe/core';
import { localModeBoxRefusal } from './box-place';
import { failedOf, settleBox } from './box-settle';
import { type CloudSessions } from './cloud';
import { type SettingsCtx } from '../layer/settings';

export type ResizeDeps = {
  boxes: Boxes;
  link: BoxLink;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  /** How long the stop and the start may each take. */
  bootMs: number;
  /** This `serve`'s open sessions on the box, by id. */
  openHere: (box: string) => string[];
  /** The box stopped for the resize: this `serve`'s sessions on it ended with it. */
  stopped: (box: string) => void;
  /**
   * A sleeping box is started at its new size: a wake, so only with room under
   * `limits.maxBoxesPerPerson` (#191); asked before EC2 is.
   */
  room?: (box: Box) => Promise<Outcome<null>>;
};

/** `where`: the checkout the command was typed in, whose limit counts a sleeping box's start. */
export type ResizeAsk = { box: string; size: string; max: string; yes: boolean; where?: string };

/** The box's open sessions from its answer to `abe session list --json`, or what it said instead. */
const listingOf = (ran: Ran): { ids: string[] } | { why: string } => {
  let doc: Envelope<SessionListData>;

  try {
    doc = readEnvelope(SessionListData, JSON.parse(ran.stdout));
  } catch {
    return { why: ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exit}` };
  }

  return doc.ok
    ? { ids: doc.data.sessions.filter((s) => holdsBox(s.state)).map((s) => s.id) }
    : { why: doc.error.message };
};

/** The box's own sessions that hold it (`abe session list` on it), or why they cannot be read. */
const boxSessions = async (link: BoxLink, box: string): Promise<Outcome<string[]>> => {
  const read = listingOf(await link.run(box, ['session', 'list', '--json']));

  return 'ids' in read
    ? { ok: true, data: read.ids }
    : refused(
        'box-unreachable',
        `cannot tell whether sessions run on box ${box} (${read.why}): --yes to resize anyway`,
      );
};

export const resizeBox = async (d: ResizeDeps, ask: ResizeAsk): Promise<Outcome<BoxResizeData>> => {
  // The size first: no box is asked for one that may not be.
  const bad = resizeRefusal({ size: ask.size, max: ask.max, running: 0, yes: true });

  if (bad !== undefined) return refused(bad.code, bad.message);
  const read = await d.boxes.status(ask.box);

  if (!read.ok) return failedOf(read);
  const box = read.data;

  if (box === null) return refused('no-box', `you have no box ${ask.box}`);
  const from = box.size;
  const answer = (changed: boolean, status: BoxState): Outcome<BoxResizeData> => ({
    ok: true,
    data: { box: box.name, from, to: ask.size, changed, status },
  });

  if (from === ask.size) return answer(false, box.state);
  const running = box.state === 'running';

  if (!running && !canStart(box.state))
    return refused('box-busy', `box ${box.name} is ${box.state}: resize it once it runs or sleeps`);
  if (!running) {
    const room = await d.room?.(box);

    if (room !== undefined && !room.ok) return room;
  }
  if (running && !ask.yes) {
    const there = await boxSessions(d.link, box.name);

    if (!there.ok) return there;
    const open = new Set([...there.data, ...d.openHere(box.name)]);
    const busy = resizeRefusal({ ...ask, running: open.size });

    if (busy !== undefined) return refused(busy.code, busy.message);
  }
  if (running) {
    const stop = await d.boxes.stop(box.name);

    if (!stop.ok) return failedOf(stop);
    const down = await settled(d, box.name, 'stopped');

    if (!down.ok) return down;
    d.stopped(box.name);
  }
  const changed = await d.boxes.resize(box.name, ask.size);

  if (!changed.ok)
    return refused(
      changed.error.code,
      `${changed.error.message}; box ${box.name} is left stopped at ${from}`,
    );
  const start = await d.boxes.start(box.name);

  if (!start.ok)
    return refused(
      start.error.code,
      `${start.error.message}; box ${box.name} is left stopped at ${ask.size}`,
    );
  const up = await settled(d, box.name, 'running');

  return up.ok ? answer(true, up.data.state) : up;
};

/** Waits for the box to be `want` (core's `boxSettling`), each of the stop and the start in `bootMs`. */
const settled = (d: ResizeDeps, name: string, want: 'running' | 'stopped') =>
  settleBox(
    { boxes: d.boxes, now: () => d.clock.now(), sleep: d.sleep, pollMs: d.pollMs },
    name,
    want,
    d.clock.now() + d.bootMs,
  );

export type BoxCtx = SettingsCtx & {
  serve: {
    cloud: CloudSessions | undefined;
  };
};

export const boxHandlers = () =>
  ({
    'box resize': async (args, ctx) => {
      // a resize starts the box again: none for a checkout in local mode (#24)
      const local = localModeBoxRefusal(ctx, ctx.cwd);

      if (local !== undefined) return local;
      if (ctx.serve.cloud === undefined)
        return refused(
          'no-boxes',
          'this abe serve fronts no boxes: boxes are resized from your local machine',
        );
      const max =
        ctx.settings?.at(ctx.cwd).values['limits.maxBoxSize'] ??
        coreDefaults()['limits.maxBoxSize'];

      return ctx.serve.cloud.resize({
        box: args.box,
        size: args.size,
        max,
        yes: args.yes,
        where: ctx.cwd,
      });
    },
  }) satisfies Partial<Handlers<BoxCtx>>;
