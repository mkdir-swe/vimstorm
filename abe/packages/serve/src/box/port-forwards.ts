/**
 * The Mac's side of a dev server on a box (#16): the forwards this `serve` holds, one per
 * workspace and port (`box`, `card`, `port`; a box may hold several cards' workspaces, #9), and
 * `abe port list|open|close`. A forward asks the box's `serve` for a relay into the workspace
 * (`workspace relay`) and keeps an ssh forward to it (`BoxLink.forward`): the box's port on this
 * Mac when free, else the next free one, said; a port the repo's auth callback fixes only itself.
 * Its box going to sleep lets the ssh go (`asleep`); its wake opens it again, the same local
 * port first. While it holds one, the box is followed so its `workspace.ports` merge here; an
 * open forward never keeps the box awake.
 */
import {
  type BoxLink,
  type Clock,
  type Event,
  type EventData,
  fixedTakenText,
  forwardKey,
  localCandidates,
  movedNote,
  type Outcome,
  type PortForward,
  type PortListData,
  type PortOffer,
  refused,
  WorkspacePortsList,
  WorkspaceRelay,
  type Handlers,
} from '@abe/core';
import { answerOf, type BoxFront } from './boxes';

type Key = { box: string; card: string; port: number };

export type PortForwards = {
  list: (box?: string) => Promise<Outcome<PortListData>>;
  open: (k: Key) => Promise<Outcome<PortForward>>;
  close: (k: Key) => Outcome<Key & { closed: true }>;
  /** Every forward let go of (serve stopping). */
  stop: () => void;
};

export type PortForwardsOptions = {
  front: Pick<BoxFront, 'list' | 'runs' | 'keep' | 'release'>;
  link: Pick<BoxLink, 'run' | 'forward'>;
  clock: Clock;
  emit: (data: EventData<'port.forward'>) => void;
  /** This serve's events as they are said: a box's `box.state` puts its forwards to sleep or wakes them. */
  watch: (see: (event: Event) => void) => () => void;
};

type Held = PortForward & { stop: (() => void) | undefined; generation: number };

const SLEEPING: ReadonlySet<string> = new Set(['stopping', 'stopped', 'terminated']);

export const startPortForwards = (o: PortForwardsOptions): PortForwards => {
  const held = new Map<string, Held>();
  const at = () => new Date(o.clock.now()).toISOString();

  const publicOf = (h: Held): PortForward => ({
    box: h.box,
    card: h.card,
    port: h.port,
    local: h.local,
    state: h.state,
    fixed: h.fixed,
    ...(h.note === undefined ? {} : { note: h.note }),
    since: h.since,
  });
  const move = (h: Held, state: PortForward['state'], note?: string) => {
    h.state = state;
    h.since = at();
    if (note === undefined) delete h.note;
    else h.note = note;
    o.emit(publicOf(h));
  };
  const holdsBox = (box: string) => [...held.values()].some((h) => h.box === box);
  const isHeld = (h: Held) => held.get(forwardKey(h)) === h;

  /** The workspaces' ports and fixed ones, as the box's `serve` reads them. */
  const portsOf = async (box: string, card?: string) =>
    answerOf(
      WorkspacePortsList,
      await o.link.run(box, [
        'workspace',
        'ports',
        ...(card === undefined ? [] : ['--card', card]),
        '--json',
      ]),
    );

  /** Our forward holding `local` now, other than `not`. */
  const holderOf = (local: number, not: string): PortForward | undefined => {
    const h = [...held.values()].find(
      (x) => x.local === local && forwardKey(x) !== not && x.state === 'open',
    );

    return h === undefined ? undefined : publicOf(h);
  };

  /** The relay asked for and the ssh forward to it, wanting `prefer` first. */
  const connect = async (h: Held, prefer?: number): Promise<Outcome<null>> => {
    h.generation += 1;
    const generation = h.generation;
    const relay = answerOf(
      WorkspaceRelay,
      await o.link.run(h.box, ['workspace', 'relay', h.card, String(h.port), '--json']),
    );

    if (!relay.ok) return relay;
    const wanted = localCandidates(h.port, h.fixed);
    const order = prefer === undefined ? wanted : [prefer, ...wanted.filter((p) => p !== prefer)];
    const first = await o.link.forward(h.box, relay.data.relay, order);
    // None of the next ones free either: any port at all, said.
    const up =
      first.ok || h.fixed || first.error.code !== 'port-taken'
        ? first
        : await o.link.forward(h.box, relay.data.relay);

    if (!up.ok)
      return up.error.code === 'port-taken' && h.fixed
        ? refused('port-taken', fixedTakenText(h.port, holderOf(h.port, forwardKey(h))))
        : up;
    // Let go of meanwhile (closed, or asleep again): not wanted any more.
    if (!isHeld(h) || h.generation !== generation) {
      up.data.stop();

      return { ok: true, data: null };
    }
    h.local = up.data.port;
    h.stop = up.data.stop;
    move(h, 'open', movedNote(h.port, h.local));
    void up.data.ended.then(async (why) => {
      if (!isHeld(h) || h.generation !== generation || why === '') return;
      h.stop = undefined;
      // Down because its box went to sleep, or failed with the box still up.
      if (await o.front.runs(h.box)) move(h, 'failed', why);
      else move(h, 'asleep');
    });

    return { ok: true, data: null };
  };

  const letGo = (h: Held) => {
    h.generation += 1;
    h.stop?.();
    h.stop = undefined;
  };

  const sleep = (box: string) => {
    for (const h of held.values())
      if (h.box === box && h.state !== 'asleep') {
        letGo(h);
        move(h, 'asleep');
      }
  };

  const wake = async (box: string) => {
    for (const h of [...held.values()])
      if (h.box === box && (h.state === 'asleep' || h.state === 'failed')) {
        move(h, 'opening');
        const up = await connect(h, h.local);

        if (!up.ok && isHeld(h)) move(h, 'failed', up.error.message);
      }
  };

  const unwatch = o.watch((event) => {
    if (event.type !== 'box.state') return;
    const { box, state } = event.data;

    if (!holdsBox(box)) return;
    if (SLEEPING.has(state)) sleep(box);
    else if (state === 'running') void wake(box);
  });

  const open: PortForwards['open'] = async (k) => {
    const key = forwardKey(k);
    const had = held.get(key);

    if (had !== undefined && (had.state === 'open' || had.state === 'opening'))
      return { ok: true, data: publicOf(had) };
    if (!(await o.front.runs(k.box)))
      return refused(
        'box-not-running',
        `box ${k.box} is not running · abe box start ${k.box} wakes it, then open the port`,
      );
    const ports = await portsOf(k.box, k.card);

    if (!ports.ok) return ports;
    const ws = ports.data.workspaces.find((w) => w.card === k.card);

    if (ws === undefined)
      return refused('no-workspace', `no running workspace for card ${k.card} on ${k.box}`);
    const h: Held = had ?? {
      ...k,
      local: k.port,
      state: 'opening',
      fixed: ws.fixed.includes(k.port),
      since: at(),
      stop: undefined,
      generation: 0,
    };

    if (had === undefined) {
      held.set(key, h);
      o.front.keep(k.box, 'forward');
    }
    move(h, 'opening');
    const up = await connect(h, had?.local);

    if (!up.ok) {
      if (isHeld(h)) {
        held.delete(key);
        if (!holdsBox(k.box)) o.front.release(k.box, 'forward');
      }

      return up;
    }

    return { ok: true, data: publicOf(h) };
  };

  const close: PortForwards['close'] = (k) => {
    const h = held.get(forwardKey(k));

    if (h === undefined)
      return refused('not-found', `${k.box} #${k.card} :${String(k.port)} is not forwarded`);
    letGo(h);
    held.delete(forwardKey(k));
    if (!holdsBox(k.box)) o.front.release(k.box, 'forward');
    o.emit({ ...publicOf(h), since: at(), closed: true });

    return { ok: true, data: { box: k.box, card: k.card, port: k.port, closed: true } };
  };

  const list: PortForwards['list'] = async (only) => {
    const listed = await o.front.list();

    if (!listed.ok) return listed;
    const running = listed.data.boxes
      .filter((b) => b.state === 'running' && (only === undefined || b.name === only))
      .map((b) => b.name);
    const read = await Promise.all(
      running.map(async (box) => ({ box, ports: await portsOf(box) })),
    );
    const offered: PortOffer[] = read.flatMap(({ box, ports }) =>
      ports.ok
        ? ports.data.workspaces.flatMap((w) =>
            w.ports
              .filter((port) => !held.has(forwardKey({ box, card: w.card, port })))
              .map((port) => ({ box, card: w.card, port, fixed: w.fixed.includes(port) })),
          )
        : [],
    );

    return {
      ok: true,
      data: {
        forwards: [...held.values()]
          .filter((h) => only === undefined || h.box === only)
          .map(publicOf),
        offered,
        unread: read.flatMap(({ box, ports }) =>
          ports.ok
            ? []
            : [
                {
                  box,
                  message: ports.error.message.includes('unknown command')
                    ? 'its abe has no workspace ports yet: update the box release'
                    : ports.error.message,
                },
              ],
        ),
      },
    };
  };

  return {
    list,
    open,
    close,
    stop: () => {
      unwatch();
      for (const h of held.values()) letGo(h);
      held.clear();
    },
  };
};

export type PortsCtx = {
  serve: {
    forwards: PortForwards | undefined;
  };
};

const NO_BOXES = refused(
  'no-boxes',
  "this abe serve fronts no boxes: a box's ports are forwarded from your local machine",
);

export const portHandlers = <C extends PortsCtx>() =>
  ({
    'port list': (args, ctx) =>
      ctx.serve.forwards === undefined
        ? Promise.resolve(NO_BOXES)
        : ctx.serve.forwards.list(args.box),
    'port open': (args, ctx) =>
      ctx.serve.forwards === undefined
        ? Promise.resolve(NO_BOXES)
        : ctx.serve.forwards.open({ box: args.box, card: args.card, port: args.port }),
    'port close': (args, ctx) =>
      Promise.resolve(
        ctx.serve.forwards === undefined
          ? NO_BOXES
          : ctx.serve.forwards.close({ box: args.box, card: args.card, port: args.port }),
      ),
  }) satisfies Partial<Handlers<C>>;
